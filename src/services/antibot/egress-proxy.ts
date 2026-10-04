import { randomBytes } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import net, { type AddressInfo, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { AppConfig } from '../../config/env.js';
import { parseHttpUrl, resolvePublicDestination } from '../../utils/url.js';
import { CrawlError, normalizeCrawlError } from '../crawl-error.js';

/** Opaque CONNECT forwarding preserves the client's TLS handshake and SNI. DNS is resolved only here. */
export class EgressProxy {
  private readonly server = http.createServer();
  private readonly sockets = new Set<Duplex>();
  private readonly password = randomBytes(24).toString('hex');
  private signal?: AbortSignal;
  private requests = 0;
  private bytes = 0;
  failure?: CrawlError;
  url = '';

  constructor(private readonly config: AppConfig) {
    this.server.requestTimeout = 15000;
    this.server.headersTimeout = 10000;
    this.server.on('connection', (socket) => {
      this.track(socket);
      socket.setTimeout(15000, () => socket.destroy());
    });
    this.server.on('request', (req, res) => { void this.forwardHttp(req, res); });
    this.server.on('connect', (req, socket, head) => { void this.forwardTunnel(req, socket, head); });
    this.server.on('clientError', (_error, socket) => socket.destroy());
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
    });
    this.url = `http://crawler:${this.password}@127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  activate(signal: AbortSignal): () => void {
    signal.throwIfAborted();
    if (this.signal) throw new CrawlError('INTERNAL_ERROR', 'A session cannot be used concurrently.');
    this.signal = signal;
    this.failure = undefined;
    this.requests = 0;
    this.bytes = 0;
    const abort = () => this.destroySockets();
    signal.addEventListener('abort', abort, { once: true });
    return () => {
      signal.removeEventListener('abort', abort);
      this.destroySockets();
      this.signal = undefined;
    };
  }

  private track(socket: Duplex): void {
    this.sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => this.sockets.delete(socket));
  }

  private destroySockets(): void { for (const socket of this.sockets) socket.destroy(); }

  private authorize(req: IncomingMessage): AbortSignal {
    const expected = `Basic ${Buffer.from(`crawler:${this.password}`).toString('base64')}`;
    if (!this.signal || req.headers['proxy-authorization'] !== expected) {
      throw new CrawlError('PROXY_ERROR', 'Invalid local proxy session.');
    }
    this.signal.throwIfAborted();
    if (++this.requests > this.config.MAX_BROWSER_REQUESTS) {
      throw new CrawlError('RESPONSE_TOO_LARGE', 'The browser request budget was exceeded.');
    }
    return this.signal;
  }

  private record(error: unknown): void {
    // Optional browser subresources may fail independently (for example, an IPv6-only
    // analytics host on an IPv4-only runtime). Preserve only policy/resource failures
    // that must invalidate the whole retrieval; main-document failures surface through
    // the browser navigation itself.
    if (!(error instanceof CrawlError)) return;
    if (error.message === 'Invalid local proxy session.') return;
    if (['DISALLOWED_DESTINATION', 'RESPONSE_TOO_LARGE'].includes(error.kind)) {
      this.failure ??= error;
    }
  }

  private countWireBytes(chunk: Buffer): void {
    this.bytes += chunk.length;
    if (this.bytes > this.config.MAX_BROWSER_NETWORK_BYTES) {
      this.failure = new CrawlError('RESPONSE_TOO_LARGE', 'The browser network byte budget was exceeded.');
      this.destroySockets();
    }
  }

  private async connectDestination(url: URL, signal: AbortSignal): Promise<Socket> {
    const addresses = await resolvePublicDestination(url.href, signal);
    // Prefer IPv4 when both families are public; many sandbox/CI hosts have no IPv6 route.
    const address = addresses.find((candidate) => candidate.family === 4) ?? addresses[0];
    if (!address) throw new CrawlError('FETCH_FAILED', 'No destination address was found.');
    signal.throwIfAborted();
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (!this.config.PROXY_URL) {
      return new Promise<Socket>((resolve, reject) => {
        // Connect to the validated numeric IP, never resolve the destination a second time.
        const socket = net.connect({ host: address.address, family: address.family, port, signal });
        this.track(socket);
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
      });
    }
    const proxy = new URL(this.config.PROXY_URL);
    const authority = `${net.isIP(address.address) === 6 ? `[${address.address}]` : address.address}:${port}`;
    return new Promise<Socket>((resolve, reject) => {
      const request = (proxy.protocol === 'https:' ? https : http).request({
        hostname: proxy.hostname, port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
        method: 'CONNECT', path: authority, agent: false, signal,
        headers: { host: authority,
          ...(proxy.username || proxy.password ? { 'proxy-authorization': `Basic ${Buffer.from(
            `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` } : {}) },
      });
      request.on('socket', (socket) => this.track(socket));
      request.once('connect', (response, socket, head) => {
        if (response.statusCode !== 200) {
          socket.destroy();
          reject(new CrawlError('PROXY_ERROR', response.statusCode === 407
            ? 'Upstream proxy authentication failed.' : 'The upstream proxy refused the connection.'));
          return;
        }
        this.track(socket);
        if (head.length) socket.unshift(head);
        resolve(socket);
      });
      request.once('error', (error) => reject(signal.aborted ? signal.reason
        : new CrawlError('PROXY_ERROR', 'Unable to connect to the configured proxy.', { cause: error })));
      request.end();
    });
  }

  private async forwardTunnel(req: IncomingMessage, downstream: Duplex, head: Buffer): Promise<void> {
    try {
      const signal = this.authorize(req);
      const url = parseHttpUrl(`https://${req.url ?? ''}/`);
      const upstream = await this.connectDestination(url, signal);
      signal.throwIfAborted();
      downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.on('data', (chunk: Buffer) => this.countWireBytes(chunk));
      downstream.on('data', (chunk: Buffer) => this.countWireBytes(chunk));
      downstream.once('close', () => upstream.destroy());
      upstream.once('close', () => downstream.destroy());
      downstream.pipe(upstream).pipe(downstream);
    } catch (error) {
      this.record(error);
      const unauthorized = error instanceof CrawlError && error.message === 'Invalid local proxy session.';
      if (!downstream.destroyed) downstream.end(unauthorized
        ? 'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="crawler"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
        : 'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }
  }

  private async forwardHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const signal = this.authorize(req);
      const url = parseHttpUrl(req.url ?? '');
      if (url.protocol !== 'http:') throw new CrawlError('INVALID_URL', 'HTTPS must use CONNECT.');
      const socket = await this.connectDestination(url, signal);
      signal.throwIfAborted();
      const agent = new http.Agent({ keepAlive: false });
      agent.createConnection = () => socket;
      const headers: http.OutgoingHttpHeaders = { ...req.headers, host: url.host };
      for (const key of ['proxy-authorization', 'proxy-connection', 'connection', 'upgrade']) delete headers[key];
      const upstream = http.request(url, { method: req.method, headers, agent, signal }, (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.on('data', (chunk: Buffer) => this.countWireBytes(chunk));
        response.on('error', (error) => { this.record(error); res.destroy(); });
        response.pipe(res);
      });
      upstream.on('error', (error) => {
        this.record(error);
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.on('data', (chunk: Buffer) => this.countWireBytes(chunk));
      req.on('error', () => upstream.destroy());
      res.once('close', () => { upstream.destroy(); agent.destroy(); });
      req.pipe(upstream);
    } catch (error) {
      this.record(error);
      if (!res.headersSent) res.writeHead(error instanceof CrawlError && error.message === 'Invalid local proxy session.' ? 407 : 502,
        { 'proxy-authenticate': 'Basic realm="crawler"' });
      res.end();
    }
  }

  async close(): Promise<void> {
    this.destroySockets();
    if (this.server.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
