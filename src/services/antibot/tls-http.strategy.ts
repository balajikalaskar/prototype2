import { Impit } from 'impit';
import { CookieJar } from 'tough-cookie';
import type { AppConfig } from '../../config/env.js';
import { parseHttpUrl } from '../../utils/url.js';
import { CrawlError, normalizeCrawlError } from '../crawl-error.js';
import { EgressProxy } from './egress-proxy.js';
import { readBoundedBody, stageSignal } from './helpers.js';
import { SessionStore } from './session-store.js';
import type { RetrievalContext, RetrievedPage } from './types.js';

export class TlsHttpStrategy {
  private readonly sessions: SessionStore<{ client: Impit; guard: EgressProxy; close(): Promise<void> }>;

  constructor(private readonly config: AppConfig) {
    this.sessions = new SessionStore(config.MAX_SESSIONS, config.SESSION_TTL_MS);
  }

  async retrieve(url: string, context: RetrievalContext): Promise<RetrievedPage> {
    const signal = stageSignal(context, this.config.HTTP_TIMEOUT_MS);
    const lease = await this.sessions.acquire(new URL(url).origin, async () => {
      const guard = new EgressProxy(this.config);
      await guard.start();
      const client = new Impit({ browser: this.config.TLS_BROWSER_PROFILE, proxyUrl: guard.url,
        cookieJar: new CookieJar(), followRedirects: false, ignoreTlsErrors: false, http3: false });
      return { client, guard, close: () => guard.close() };
    });
    let deactivate: (() => void) | undefined;
    let discard = true;
    try {
      deactivate = lease.value.guard.activate(signal);
      let current = parseHttpUrl(url).href;
      for (let redirects = 0; ; redirects++) {
        signal.throwIfAborted();
        const response = await lease.value.client.fetch(current, { signal, redirect: 'manual',
          timeout: Math.max(1, Math.min(this.config.HTTP_TIMEOUT_MS, context.deadline - Date.now())) });
        if (lease.value.guard.failure) { await response.body.cancel().catch(() => {}); throw lease.value.guard.failure; }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body.cancel().catch(() => {});
          if (!location || redirects >= this.config.MAX_REDIRECTS) {
            throw new CrawlError('REDIRECT_FAILED', 'The redirect limit was exceeded or a redirect was invalid.');
          }
          current = parseHttpUrl(new URL(location, current).href).href;
          continue;
        }
        const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
        if (response.ok && !['text/html', 'application/xhtml+xml'].includes(contentType)) {
          await response.body.cancel().catch(() => {});
          throw new CrawlError('UNSUPPORTED_CONTENT', 'Destination must return HTML or XHTML.');
        }
        const html = await readBoundedBody(response.body,
          response.ok ? this.config.MAX_RESPONSE_BYTES : Math.min(8192, this.config.MAX_RESPONSE_BYTES), signal, !response.ok);
        if (lease.value.guard.failure) throw lease.value.guard.failure;
        discard = response.status >= 400;
        return { html, contentType, finalUrl: current, upstreamStatus: response.status, strategy: 'tls',
          headers: Object.fromEntries(response.headers.entries()) };
      }
    } catch (error) {
      throw signal.aborted ? normalizeCrawlError(signal.reason) : lease.value.guard.failure ?? normalizeCrawlError(error);
    } finally {
      deactivate?.();
      await lease.release(discard);
    }
  }

  close(): Promise<void> { return this.sessions.close(); }
}
