import { createRequire } from 'node:module';
import type * as Cheerio from 'cheerio' with { 'resolution-mode': 'require' };
import { CrawlError } from '../crawl-error.js';
import type { RetrievalContext } from './types.js';

// Crawlee uses the CommonJS declarations of this dual-module Cheerio version.
export const cheerio = createRequire(import.meta.url)('cheerio') as typeof Cheerio;

export function stageSignal(context: RetrievalContext, stageMs: number): AbortSignal {
  context.signal.throwIfAborted();
  return AbortSignal.any([context.signal, AbortSignal.timeout(Math.max(1,
    Math.min(stageMs, context.deadline - Date.now())))]);
}

export function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function readBoundedBody(body: ReadableStream<Uint8Array>, maxBytes: number,
  signal: AbortSignal, prefixOnly = false): Promise<string> {
  const reader = body.getReader();
  let bytes = 0;
  const chunks: Buffer[] = [];
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        if (!prefixOnly) throw new CrawlError('RESPONSE_TOO_LARGE', 'The response exceeds the configured byte limit.');
        chunks.push(Buffer.from(value.subarray(0, value.byteLength - (bytes - maxBytes))));
        break;
      }
      chunks.push(Buffer.from(value));
      if (prefixOnly && bytes === maxBytes) break;
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
