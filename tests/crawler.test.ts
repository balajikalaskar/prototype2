import { Agent, createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import type { LookupAddress } from 'node:dns';
import type { NormalizedOptions } from 'got-scraping';
import { createTRPCClient, httpLink } from '@trpc/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app/create-app.js';
import { loadConfig, type AppConfig } from '../src/config/env.js';
import { createLogger } from '../src/config/logger.js';
import { crawlInputSchema } from '../src/schemas/crawler.schema.js';
import { CrawlerService } from '../src/services/crawler.service.js';
import { isPublicAddress, secureDestination } from '../src/utils/url.js';
import type { AppRouter } from '../src/trpc/router.js';

const dnsLookupMock = vi.hoisted(() => vi.fn<() => Promise<Array<{ address: string; family: number }>>>());
vi.mock('node:dns/promises', () => ({ lookup: dnsLookupMock }));

let fixture: Server;
let fixturePort: number;
let requestedPaths: string[] = [];
const services: CrawlerService[] = [];
const defaults = loadConfig({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });
const logger = createLogger(defaults);
const url = (path: string) => `http://public.example:${fixturePort}${path}`;

function service(overrides: Partial<AppConfig> = {}) {
  const crawler = new CrawlerService({ ...defaults, ...overrides }, logger);
  services.push(crawler);
  return crawler;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

beforeAll(async () => {
  fixture = createServer((req, res) => {
    const path = req.url ?? '/';
    requestedPaths.push(path);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (path === '/private-redirect') {
      res.writeHead(302, { location: `http://127.0.0.1:${fixturePort}/one` }); res.end(); return;
    }
    if (path === '/redirect') {
      res.writeHead(302, { location: '/one' }); res.end(); return;
    }
    if (path === '/loop') {
      res.writeHead(302, { location: '/loop' }); res.end(); return;
    }
    if (path === '/failure') { req.socket.destroy(); return; }
    if (path === '/not-found') { res.writeHead(404); res.end('<h1>Missing</h1>'); return; }
    if (path === '/json') { res.setHeader('content-type', 'application/json'); res.end('{"hello":true}'); return; }
    if (path === '/large') {
      res.setHeader('content-length', '4096'); res.end('x'.repeat(4096)); return;
    }
    if (path === '/gzip-large') {
      res.setHeader('content-encoding', 'gzip'); res.end(gzipSync('<p>' + 'x'.repeat(4096) + '</p>')); return;
    }
    if (path === '/chunked-large') {
      res.write('<p>' + 'x'.repeat(2048)); res.end('x'.repeat(2048) + '</p>'); return;
    }
    if (path === '/slow') {
      const timer = setTimeout(() => res.end('<h1>Too late</h1>'), 1000);
      res.on('close', () => clearTimeout(timer)); return;
    }
    if (path === '/slow-body') {
      res.write('<body>');
      const timer = setTimeout(() => res.end('Too late</body>'), 1000);
      res.on('close', () => clearTimeout(timer)); return;
    }
    const name = path === '/two' ? 'Two' : 'One';
    res.end(`<html lang="en"><head><title>${name}</title></head><body><h1>${name}</h1><a href="/discovered">Next</a></body></html>`);
  });
  fixturePort = await listen(fixture);
});

beforeEach(() => {
  requestedPaths = [];
  dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  // Only the test transport points at loopback. Production DNS validation and redirect hooks still run.
  vi.spyOn(Agent.prototype, 'createConnection').mockImplementation(() => connect({ host: '127.0.0.1', port: fixturePort }));
});

afterEach(async () => {
  await Promise.all(services.splice(0).map((crawler) => crawler.close()));
  vi.restoreAllMocks();
});

afterAll(async () => {
  fixture.closeAllConnections();
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
});

describe('URL validation and destination safeguards', () => {
  it.each(['', 'not a URL', '/relative', 'ftp://example.com', 'file:///etc/passwd',
    'https://user:password@example.com', `https://example.com/${'x'.repeat(2048)}`])('rejects invalid input %s', (value) => {
    expect(crawlInputSchema.safeParse({ url: value }).success).toBe(false);
  });

  it.each(['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254',
    '0.0.0.0', '100.64.0.1', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1'])('blocks non-public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it('accepts public IPv4 and IPv6 addresses', () => {
    expect(isPublicAddress('93.184.216.34')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });

  it.each(['http://localhost', 'http://127.0.0.1', 'http://2130706433', 'http://[::1]', 'http://[::ffff:127.0.0.1]'])('blocks literal/local destination %s before connecting', async (destination) => {
    await expect(service().crawl({ url: destination })).rejects.toMatchObject({ kind: 'DISALLOWED_DESTINATION' });
    expect(requestedPaths).toEqual([]);
  });

  it('blocks hostnames with mixed public/private DNS answers', async () => {
    dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.2', family: 4 }]);
    await expect(service().crawl({ url: url('/one') })).rejects.toMatchObject({ kind: 'DISALLOWED_DESTINATION' });
    expect(requestedPaths).toEqual([]);
  });

  it('pins the socket lookup to validated addresses rather than querying DNS again', async () => {
    const options: Pick<NormalizedOptions, 'url' | 'dnsCache' | 'dnsLookup'> = {
      url: new URL(url('/one')), dnsCache: undefined, dnsLookup: undefined,
    };
    const callsBefore = dnsLookupMock.mock.calls.length;
    await secureDestination(options, new AbortController().signal);
    dnsLookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const pinned = options.dnsLookup;
    if (!pinned) throw new Error('A pinned lookup should be configured.');
    const resolved = await new Promise<string | LookupAddress[]>((resolve, reject) => {
      pinned('public.example', { all: true }, (error, address) => error ? reject(error) : resolve(address));
    });
    expect(resolved).toEqual([{ address: '93.184.216.34', family: 4 }]);
    expect(dnsLookupMock.mock.calls.length - callsBefore).toBe(1);
  });

  it('checks redirects before making the next connection', async () => {
    await expect(service().crawl({ url: url('/private-redirect') })).rejects.toMatchObject({ kind: 'DISALLOWED_DESTINATION' });
    expect(requestedPaths).toEqual(['/private-redirect']);
  });

  it('handles DNS errors without issuing an HTTP request', async () => {
    dnsLookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(service().crawl({ url: url('/one') })).rejects.toMatchObject({ kind: 'FETCH_FAILED' });
    expect(requestedPaths).toEqual([]);
  });
});

describe('single-page crawling', () => {
  it('returns parsed data and follows only HTTP redirects', async () => {
    const submitted = url('/redirect');
    const result = await service().crawl({ url: submitted });
    expect(result).toMatchObject({ url: submitted, finalUrl: url('/one'), httpStatus: 200, title: 'One',
      language: 'en', headings: [{ level: 1, text: 'One' }], links: [{ text: 'Next', url: url('/discovered') }] });
    expect(result.meta.durationMs).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(result.meta.fetchedAt))).toBe(false);
    expect(requestedPaths).toEqual(['/redirect', '/one']);
  });

  it('keeps simultaneous results isolated, including identical submitted URLs', async () => {
    const crawler = service();
    const results = await Promise.all(['/one', '/two', '/one'].map((path) => crawler.crawl({ url: url(path) })));
    expect(results.map((result) => result.title)).toEqual(['One', 'Two', 'One']);
    expect(requestedPaths.sort()).toEqual(['/one', '/one', '/two']);
  });

  it.each([
    ['/failure', 'FETCH_FAILED'], ['/not-found', 'UPSTREAM_HTTP_ERROR'],
    ['/json', 'UNSUPPORTED_CONTENT'], ['/loop', 'REDIRECT_FAILED'],
    ['/large', 'RESPONSE_TOO_LARGE'], ['/chunked-large', 'RESPONSE_TOO_LARGE'],
    ['/gzip-large', 'RESPONSE_TOO_LARGE'],
  ])('reports %s failures and releases capacity', async (path, kind) => {
    const crawler = service({ MAX_CONCURRENT_CRAWLS: 1, MAX_RESPONSE_BYTES: 1024, MAX_REDIRECTS: 2 });
    await expect(crawler.crawl({ url: url(path) })).rejects.toMatchObject({ kind });
    expect((await crawler.crawl({ url: url('/one') })).title).toBe('One');
    if (path === '/failure') expect(requestedPaths.filter((entry) => entry === path)).toHaveLength(1);
  });

  it.each(['/slow', '/slow-body'])('cancels timed-out work at %s and releases capacity', async (path) => {
    const crawler = service({ CRAWL_TIMEOUT_MS: 150, MAX_CONCURRENT_CRAWLS: 1 });
    const started = performance.now();
    await expect(crawler.crawl({ url: url(path) })).rejects.toMatchObject({ kind: 'TIMEOUT' });
    expect(performance.now() - started).toBeLessThan(800);
    expect((await crawler.crawl({ url: url('/one') })).title).toBe('One');
  });

  it('bounds stalled DNS lookups with the overall deadline', async () => {
    dnsLookupMock.mockImplementation(() => new Promise(() => {}));
    const started = performance.now();
    await expect(service({ CRAWL_TIMEOUT_MS: 150 }).crawl({ url: url('/one') })).rejects.toMatchObject({ kind: 'TIMEOUT' });
    expect(performance.now() - started).toBeLessThan(800);
  });

  it('rejects excess work immediately instead of queueing it', async () => {
    const crawler = service({ MAX_CONCURRENT_CRAWLS: 1, CRAWL_TIMEOUT_MS: 150 });
    const pending = crawler.crawl({ url: url('/slow') }).catch((error: unknown) => error);
    await expect(crawler.crawl({ url: url('/two') })).rejects.toMatchObject({ kind: 'CAPACITY_EXHAUSTED' });
    expect(await pending).toMatchObject({ kind: 'TIMEOUT' });
    expect((await crawler.crawl({ url: url('/one') })).title).toBe('One');
  });

  it('aborts active work during shutdown and rejects new requests', async () => {
    const crawler = service();
    const pending = crawler.crawl({ url: url('/slow') }).catch((error: unknown) => error);
    await crawler.close();
    expect(await pending).toMatchObject({ kind: 'SHUTTING_DOWN' });
    await expect(crawler.crawl({ url: url('/one') })).rejects.toMatchObject({ kind: 'SHUTTING_DOWN' });
  });
});

describe('Express and tRPC API', () => {
  it('serves health, a standard mutation envelope, typed clients, and classified errors without stacks', async () => {
    const crawler = service();
    const api = createServer(createApp(crawler, logger));
    // Use the real listener; the socket redirection mock is exclusively for crawl agents.
    const port = await listen(api);
    const base = `http://127.0.0.1:${port}`;
    try {
      expect(await (await fetch(`${base}/health`)).json()).toEqual({ status: 'ok' });
      const response = await fetch(`${base}/trpc/crawler.crawl`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: url('/one') }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('x-request-id')).toBeTruthy();
      expect(await response.json()).toMatchObject({ result: { data: { title: 'One', url: url('/one') } } });
      const client = createTRPCClient<AppRouter>({ links: [httpLink({ url: `${base}/trpc` })] });
      expect((await client.crawler.crawl.mutate({ url: url('/two') })).title).toBe('Two');
      const invalid = await fetch(`${base}/trpc/crawler.crawl`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'file:///etc/passwd' }),
      });
      expect(invalid.status).toBe(400);
      expect(JSON.stringify(await invalid.json())).not.toContain('stack');
      const blocked = await fetch(`${base}/trpc/crawler.crawl`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://127.0.0.1' }),
      });
      expect(blocked.status).toBe(403);
      expect(await blocked.json()).toMatchObject({ error: { data: { code: 'FORBIDDEN', reason: 'DISALLOWED_DESTINATION' } } });
      const malformed = await fetch(`${base}/trpc/crawler.crawl`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{invalid',
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toEqual({ error: 'Invalid request body.' });
      vi.spyOn(crawler, 'crawl').mockRejectedValueOnce(new Error('Hidden internal implementation details'));
      const internal = await fetch(`${base}/trpc/crawler.crawl`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: url('/one') }),
      });
      expect(internal.status).toBe(500);
      const internalBody = JSON.stringify(await internal.json());
      expect(internalBody).toContain('An internal error occurred.');
      expect(internalBody).not.toContain('Hidden internal');
      expect(internalBody).not.toContain('stack');
    } finally {
      api.closeAllConnections();
      await new Promise<void>((resolve) => api.close(() => resolve()));
    }
  });
});

describe('environment configuration', () => {
  it('validates defaults and rejects invalid bounds', () => {
    expect(loadConfig({}).MAX_CONCURRENT_CRAWLS).toBe(5);
    expect(() => loadConfig({ CRAWL_TIMEOUT_MS: '0' })).toThrow('Invalid environment configuration');
    expect(() => loadConfig({ MAX_RESPONSE_BYTES: 'unbounded' })).toThrow('Invalid environment configuration');
  });
});
