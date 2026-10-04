import { Readable, Transform } from 'node:stream';
// Load the HTTP transport during startup instead of on the first crawl's latency path.
import 'got-scraping';
import {
  GotScrapingHttpClient,
  type HttpRequest,
  type RedirectHandler,
  type StreamingHttpResponse,
} from '@crawlee/core';
import { CrawlError } from './crawl-error.js';

/** Uses Crawlee's public HTTP-client extension point to cap decoded bytes before parsing. */
export class BoundedHttpClient extends GotScrapingHttpClient {
  constructor(private readonly maxBytes: number) { super(); }

  override async stream(request: HttpRequest, redirect?: RedirectHandler): Promise<StreamingHttpResponse> {
    const response = await super.stream(request, redirect);
    const source = response.stream;
    const rejectResponse = (error: CrawlError): never => {
      source.destroy();
      throw error;
    };
    const inspectFailure = [403, 429, 503].includes(response.statusCode);
    if ((response.statusCode < 200 || response.statusCode >= 300) && !inspectFailure) {
      rejectResponse(new CrawlError('UPSTREAM_HTTP_ERROR', `Destination returned HTTP ${response.statusCode}.`, undefined,
        { upstreamStatus: response.statusCode }));
    }
    const contentType = String(response.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    if (inspectFailure) {
      if (!['text/html', 'application/xhtml+xml', 'text/plain', 'application/json'].includes(contentType ?? '')) {
        rejectResponse(new CrawlError(response.statusCode === 429 ? 'RATE_LIMITED' : 'BOT_BLOCKED',
          `Destination returned HTTP ${response.statusCode}.`, undefined, { upstreamStatus: response.statusCode }));
      }
      // Error pages are diagnostics, not documents: retain only a small decoded prefix.
      const limit = Math.min(8192, this.maxBytes);
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        chunks.push(buffer.subarray(0, limit - bytes));
        bytes += Math.min(buffer.length, limit - bytes);
        if (bytes >= limit) break;
      }
      source.destroy();
      return { ...response, stream: Readable.from(chunks) };
    }
    if (!inspectFailure && contentType !== 'text/html' && contentType !== 'application/xhtml+xml') {
      rejectResponse(new CrawlError('UNSUPPORTED_CONTENT', 'Destination must return HTML or XHTML.'));
    }
    if (Number(response.headers['content-length']) > this.maxBytes) {
      rejectResponse(new CrawlError('RESPONSE_TOO_LARGE', 'The response exceeds the configured byte limit.'));
    }

    let bytes = 0;
    const maxBytes = this.maxBytes;
    const bounded = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > maxBytes) callback(new CrawlError('RESPONSE_TOO_LARGE', 'The response exceeds the configured byte limit.'));
        else callback(null, chunk);
      },
    });
    source.on('error', (error: Error) => bounded.destroy(error));
    // Install an error listener before piping; Crawlee attaches its parser after this method resolves.
    bounded.on('error', () => source.destroy());
    bounded.on('close', () => { if (!source.readableEnded) source.destroy(); });
    source.pipe(bounded);
    return { ...response, stream: bounded };
  }
}
