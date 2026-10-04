import { Agent, createServer, type Server } from 'node:http';
import net, { type AddressInfo, type SocketConnectOpts } from 'node:net';
import { once } from 'node:events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type AppConfig } from '../src/config/env.js';
import { createLogger } from '../src/config/logger.js';
import { createApp } from '../src/app/create-app.js';
import { CrawlerService } from '../src/services/crawler.service.js';
import { EgressProxy } from '../src/services/antibot/egress-proxy.js';
import { classifyResponse } from '../src/services/antibot/response-classifier.js';
import { SessionStore } from '../src/services/antibot/session-store.js';
import type { RetrievedPage } from '../src/services/antibot/types.js';

const dns = vi.hoisted(() => vi.fn<() => Promise<Array<{ address: string; family: number }>>>());
vi.mock('node:dns/promises', () => ({ lookup: dns }));
const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const logger = createLogger(config);
const connect = net.connect.bind(net);
let fixture: Server;
let port: number;
let paths: string[] = [];
let userAgents: string[] = [];
const crawlers: CrawlerService[] = [];
function crawler(overrides: Partial<AppConfig> = {}) {
  const value = new CrawlerService({ ...config, ...overrides }, logger);
  crawlers.push(value);
  return value;
}
const url = (path: string) => `http://public.example:${port}${path}`;
const page = (html: string, status = 200, headers: Record<string, string> = {}): RetrievedPage => ({
  html, upstreamStatus: status, headers, finalUrl: 'https://example.com', strategy: 'http', contentType: 'text/html',
});

beforeAll(async () => {
  fixture = createServer((req, res) => {
    const path = req.url ?? '/';
    paths.push(path);
    const ua = req.headers['user-agent'] ?? '';
    userAgents.push(ua);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (path === '/rate') { res.writeHead(429, { 'retry-after': '60' }); res.end('Slow down'); return; }
    if (path === '/captcha') {
      res.end('<title>Verify you are human</title><main>Complete the CAPTCHA</main><div class="h-captcha"></div>'); return;
    }
    if (path === '/article') {
      res.end('<title>Cloudflare and CAPTCHA explained</title><article>' + 'An educational article about Cloudflare, Akamai, and CAPTCHA widgets. '.repeat(5)
        + '</article><form><div class="g-recaptcha"></div></form>'); return;
    }
    if (path === '/private') { res.writeHead(302, { location: 'http://127.0.0.1/private' }); res.end(); return; }
    if (path === '/slow') {
      const timer = setTimeout(() => res.end('<main>Too late</main>'), 2000);
      res.on('close', () => clearTimeout(timer)); return;
    }
    const isRealBrowser = /Chrome\/(?!151\.)/.test(ua) && !ua.includes('CrawlerPrototype');
    if (path.startsWith('/browser') && !isRealBrowser || path.startsWith('/tls') && ua.includes('CrawlerPrototype')) {
      res.writeHead(403); res.end('<title>Access denied</title><main>Access denied</main>'); return;
    }
    if (path === '/content') { res.end('<main>Verified protected fixture content</main>'); return; }
    if (path === '/browser-private') {
      res.end('<title>Loading</title><div id="root">Loading...</div><script>fetch("http://127.0.0.1:'+ port +'/secret").catch(()=>{});</script>'); return;
    }
    if (path === '/browser-js' || path === '/js') {
      res.end('<title>Loading</title><div id="root">Loading...</div><script>setTimeout(async()=>{const r=await fetch("/content");document.querySelector("#root").innerHTML=await r.text();document.title="Rendered fixture";},150)</script>'); return;
    }
    if (path.endsWith('-cookie')) {
      const count = Number(/visit=(\d+)/.exec(req.headers.cookie ?? '')?.[1] ?? 0) + 1;
      res.setHeader('set-cookie', `visit=${count}; Path=/; HttpOnly`);
      res.end(`<title>Visit ${count}</title><main>Anonymous visit ${count}</main>`); return;
    }
    if (path === '/tls-large') { res.end('<main>' + 'x'.repeat(4096) + '</main>'); return; }
    if (path === '/browser-loop') { res.writeHead(302, { location: '/browser-loop' }); res.end(); return; }
    res.end('<title>Successful fixture</title><main>Verified protected fixture content</main>');
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  port = (fixture.address() as AddressInfo).port;
});

beforeEach(() => {
  paths = [];
  userAgents = [];
  dns.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  // Redirect only the validated fixture address. Chromium and Impit themselves use the real local guard.
  vi.spyOn(net, 'connect').mockImplementation(((options: SocketConnectOpts) => {
    if ('host' in options && options.host === '93.184.216.34') return connect({ ...options, host: '127.0.0.1', port });
    return connect(options);
  }) as typeof net.connect);
  vi.spyOn(Agent.prototype, 'createConnection').mockImplementation((options) => {
    if ('host' in options && options.host === 'public.example') return connect({ host: '127.0.0.1', port });
    return connect({ host: String(options.host ?? '127.0.0.1'), port: Number(options.port) });
  });
});

afterEach(async () => {
  await Promise.all(crawlers.splice(0).map((value) => value.close()));
  vi.restoreAllMocks();
});
afterAll(async () => {
  fixture.closeAllConnections();
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
});

describe('classification', () => {
  it('uses strong challenge headers even on HTTP 200', () => {
    expect(classifyResponse(page('<main>Verifying</main>', 200, { 'cf-mitigated': 'challenge' })))
      .toEqual({ kind: 'BROWSER_CHALLENGE', provider: 'cloudflare' });
    expect(classifyResponse(page('<script>function triggerInterstitialChallenge(){}</script>')))
      .toEqual({ kind: 'BROWSER_CHALLENGE', provider: 'akamai' });
  });
  it('does not infer blocking from CDN headers or article keywords', () => {
    expect(classifyResponse(page('<title>Cloudflare explained</title><article>Cloudflare, Akamai and CAPTCHA are topics.</article>',
      200, { server: 'cloudflare', 'cf-ray': 'id' })).kind).toBe('USABLE_CONTENT');
  });
  it('recognizes an active gate but not a widget on a readable article', () => {
    expect(classifyResponse(page('<title>Verify you are human</title><main>Complete the CAPTCHA</main><div class="h-captcha"></div>')).kind).toBe('CAPTCHA_REQUIRED');
    expect(classifyResponse(page('<title>Article</title><article>' + 'Readable content. '.repeat(20)
      + '</article><form><div class="g-recaptcha"></div></form>')).kind).toBe('USABLE_CONTENT');
  });
  it('recognizes JS shells and login gates', () => {
    expect(classifyResponse(page('<div id="root">Loading...</div><script src="app.js"></script>')).kind).toBe('JAVASCRIPT_REQUIRED');
    expect(classifyResponse(page('<html><head></head><body></body></html>')).kind).toBe('JAVASCRIPT_REQUIRED');
    expect(classifyResponse(page('<title>Sign in</title><form><input type="password"></form>')).kind).toBe('LOGIN_REQUIRED');
  });
});

describe('actual retrieval ladder', () => {
  it('keeps normal pages on the Crawlee HTTP fast path', async () => {
    const result = await crawler().crawl({ url: url('/normal') });
    expect(result.meta).toMatchObject({ strategy: 'http', rendered: false, attemptCount: 1 });
    expect(paths).toEqual(['/normal']);
  });
  it('resolves header-based denial with the real native HTTP profile and remembers the exact URL', async () => {
    const service = crawler();
    const first = await service.crawl({ url: url('/tls') });
    expect(first.text).toContain('Verified protected fixture content');
    expect(first.meta).toMatchObject({ strategy: 'tls', attemptCount: 2 });
    expect(userAgents[0]).toContain('CrawlerPrototype');
    expect(userAgents[1]).toMatch(/Chrome\/151\./);
    expect((await service.crawl({ url: url('/tls') })).meta.attemptCount).toBe(1);
  });
  it('falls back through real HTTP/TLS requests to real browser execution', async () => {
    const result = await crawler().crawl({ url: url('/browser-js') });
    expect(result.title).toBe('Rendered fixture');
    expect(result.text).toContain('Verified protected fixture content');
    expect(result.meta).toMatchObject({ strategy: 'browser', rendered: true, attemptCount: 3 });
    expect(result.httpStatus).toBe(200);
  });
  it('renders a JavaScript shell without claiming the loading page is a result', async () => {
    const result = await crawler().crawl({ url: url('/js') });
    expect(result.text).toContain('Verified protected fixture content');
    expect(result.meta.strategy).toBe('browser');
  });
  it('detects CAPTCHA/rate limits without launching more strategies and recovers capacity', async () => {
    const service = crawler({ MAX_CONCURRENT_CRAWLS: 1 });
    await expect(service.crawl({ url: url('/captcha') })).rejects.toMatchObject({ kind: 'CAPTCHA_REQUIRED',
      diagnostics: { attemptedStrategies: ['http'] } });
    await expect(service.crawl({ url: url('/rate') })).rejects.toMatchObject({ kind: 'RATE_LIMITED',
      diagnostics: { upstreamStatus: 429, retryAfterMs: 60000, attemptedStrategies: ['http'] } });
    expect((await service.crawl({ url: url('/article') })).meta.strategy).toBe('http');
  });
  it('retains scoped cookies within each exclusive native session', async () => {
    const service = crawler();
    expect((await service.crawl({ url: url('/tls-cookie') })).title).toBe('Visit 1');
    expect((await service.crawl({ url: url('/tls-cookie') })).title).toBe('Visit 2');
  });
  it('leases separate native cookie jars for simultaneous calls', async () => {
    const service = crawler();
    const results = await Promise.all([1, 2].map(() => service.crawl({ url: url('/tls-cookie'), mode: 'tls' })));
    expect(results.map((result) => result.title)).toEqual(['Visit 1', 'Visit 1']);
  });
  it('retains browser state within leased contexts without transferring it to TLS', async () => {
    const service = crawler();
    expect((await service.crawl({ url: url('/browser-cookie'), mode: 'browser' })).title).toBe('Visit 1');
    expect((await service.crawl({ url: url('/browser-cookie'), mode: 'browser' })).title).toBe('Visit 2');
    expect((await service.crawl({ url: url('/tls-cookie'), mode: 'tls' })).title).toBe('Visit 1');
  });
  it.each(['tls', 'browser'] as const)('blocks private redirects in %s', async (mode) => {
    await expect(crawler().crawl({ url: url('/private'), mode })).rejects.toMatchObject({ kind: 'DISALLOWED_DESTINATION' });
    expect(paths).not.toContain('/secret');
  });
  it('blocks private browser subresources through the connection guard', async () => {
    await expect(crawler().crawl({ url: url('/browser-private'), mode: 'browser' })).rejects.toMatchObject({ kind: 'DISALLOWED_DESTINATION' });
    expect(paths).not.toContain('/secret');
  });
  it('caps native decoded response sizes', async () => {
    await expect(crawler({ MAX_RESPONSE_BYTES: 1024 }).crawl({ url: url('/tls-large'), mode: 'tls' }))
      .rejects.toMatchObject({ kind: 'RESPONSE_TOO_LARGE' });
  });
  it('cancels native work using the shared deadline and releases capacity', async () => {
    const service = crawler({ CRAWL_TIMEOUT_MS: 200, MAX_CONCURRENT_CRAWLS: 1 });
    const start = performance.now();
    await expect(service.crawl({ url: url('/slow'), mode: 'tls' })).rejects.toMatchObject({ kind: 'TIMEOUT' });
    expect(performance.now() - start).toBeLessThan(1000);
    expect((await service.crawl({ url: url('/normal') })).title).toBe('Successful fixture');
  });
  it('serves the fallback result and CAPTCHA diagnostics through the actual tRPC API', async () => {
    const api = createServer(createApp(crawler(), logger));
    api.listen(0, '127.0.0.1'); await once(api, 'listening');
    const endpoint = `http://127.0.0.1:${(api.address() as AddressInfo).port}/trpc/crawler.crawl`;
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: url('/tls') }) });
      expect(await response.json()).toMatchObject({ result: { data: { text: 'Verified protected fixture content', meta: { strategy: 'tls' } } } });
      const captcha = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: url('/captcha') }) });
      expect(captcha.status).toBe(412);
      expect(await captcha.json()).toMatchObject({ error: { data: { reason: 'CAPTCHA_REQUIRED', upstreamStatus: 200 } } });
    } finally { api.closeAllConnections(); await new Promise<void>((resolve) => api.close(() => resolve())); }
  });
});

describe('guard and session lifecycle', () => {
  it('connects only to the DNS-validated IP, even if the next DNS answer rebinds', async () => {
    const guard = new EgressProxy(config);
    await guard.start();
    const deactivate = guard.activate(new AbortController().signal);
    try {
      dns.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
        .mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
      const { Impit } = await import('impit');
      const client = new Impit({ proxyUrl: guard.url, browser: 'chrome151' });
      const response = await client.fetch(url('/normal'));
      expect(await response.text()).toContain('Verified protected fixture');
      expect(dns).toHaveBeenCalledTimes(1);
      expect(net.connect).toHaveBeenCalledWith(expect.objectContaining({ host: '93.184.216.34' }));
    } finally { deactivate(); await guard.close(); }
  });
  it('never concurrently leases mutable session state and closes evicted resources', async () => {
    const store = new SessionStore<{ close(): Promise<void>; id: number }>(2, 1000);
    let next = 0;
    const closed: number[] = [];
    const create = async () => { const id = ++next; return { id, close: async () => { closed.push(id); } }; };
    try {
      const first = await store.acquire('origin', create);
      const second = await store.acquire('origin', create);
      expect(first.value.id).not.toBe(second.value.id);
      await expect(store.acquire('origin', create)).rejects.toMatchObject({ kind: 'CAPACITY_EXHAUSTED' });
      await first.release();
      const reused = await store.acquire('origin', create);
      expect(reused.value.id).toBe(first.value.id);
      await reused.release(true); await second.release(true);
      expect(closed.sort()).toEqual([1, 2]);
    } finally { await store.close(); }
  });
});
