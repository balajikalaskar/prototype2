import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser, type BrowserContext, type Page } from 'patchright';
import type { AppConfig } from '../../config/env.js';
import { CrawlError, normalizeCrawlError } from '../crawl-error.js';
import { EgressProxy } from './egress-proxy.js';
import { awaitWithSignal, stageSignal } from './helpers.js';
import { classifyResponse } from './response-classifier.js';
import { SessionStore } from './session-store.js';
import type { RetrievalContext, RetrievedPage } from './types.js';

export class BrowserStrategy {
  private runtime?: Promise<Browser>;
  private active = 0;
  private readonly sessions: SessionStore<{ context: BrowserContext; guard: EgressProxy; close(): Promise<void> }>;

  constructor(private readonly config: AppConfig) {
    this.sessions = new SessionStore(config.MAX_SESSIONS, config.SESSION_TTL_MS);
  }

  private getBrowser(): Promise<Browser> {
    this.runtime ??= chromium.launch({ headless: true, channel: 'chromium',
      timeout: this.config.BROWSER_TIMEOUT_MS,
      args: ['--disable-quic', '--proxy-bypass-list=<-loopback>',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
    }).then((browser) => {
      browser.once('disconnected', () => { this.runtime = undefined; });
      return browser;
    }).catch((error: unknown) => {
      this.runtime = undefined;
      throw new CrawlError('BROWSER_UNAVAILABLE', 'Browser startup failed. Run npm run browser:install and check system dependencies.', { cause: error });
    });
    return this.runtime;
  }

  async retrieve(url: string, context: RetrievalContext): Promise<RetrievedPage> {
    if (!this.config.BROWSER_ENABLED) throw new CrawlError('BROWSER_UNAVAILABLE', 'Browser retrieval is disabled.');
    if (this.active >= this.config.MAX_BROWSER_CONCURRENCY) throw new CrawlError('CAPACITY_EXHAUSTED', 'Browser capacity is full. Try again later.');
    this.active++;
    const signal = stageSignal(context, this.config.BROWSER_TIMEOUT_MS);
    let page: Page | undefined;
    let cleanupGuard: (() => void) | undefined;
    let release: ((discard?: boolean) => Promise<void>) | undefined;
    let discard = true;
    let guard: EgressProxy | undefined;
    let abort: (() => void) | undefined;
    let failure: CrawlError | undefined;
    try {
      const lease = await this.sessions.acquire(new URL(url).origin, async () => {
        const sessionGuard = new EgressProxy(this.config);
        await sessionGuard.start();
        try {
          const browser = await awaitWithSignal(this.getBrowser(), signal);
          signal.throwIfAborted();
          const proxy = new URL(sessionGuard.url);
          const browserContext = await browser.newContext({
            proxy: { server: proxy.origin, username: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password), bypass: '<-loopback>' },
            serviceWorkers: 'block', acceptDownloads: false,
          });
          // WebSockets are outside the document-retrieval contract; prevent non-HTTP egress.
          await browserContext.routeWebSocket('**/*', (socket) => socket.close());
          return { context: browserContext, guard: sessionGuard, close: async () => {
            try { await browserContext.close(); } finally { await sessionGuard.close(); }
          } };
        } catch (error) { await sessionGuard.close(); throw error; }
      });
      release = lease.release;
      guard = lease.value.guard;
      signal.throwIfAborted();
      cleanupGuard = guard.activate(signal);
      page = await lease.value.context.newPage();
      const currentPage = page;
      let requests = 0;
      let navigations = 0;
      let decodedBytes = 0;
      let finalResponse: { url: string; status: number; headers: Record<string, string> } | undefined;
      const fail = (error: CrawlError) => {
        failure ??= error;
        void currentPage.close().catch(() => {});
      };
      abort = () => { void currentPage.close().catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      await currentPage.route('**/*', async (route) => {
        try {
          const request = route.request();
          const requestUrl = new URL(request.url());
          if (!['http:', 'https:'].includes(requestUrl.protocol)) { await route.continue(); return; }
          if (++requests > this.config.MAX_BROWSER_REQUESTS) throw new CrawlError('RESPONSE_TOO_LARGE', 'The browser request budget was exceeded.');
          if (request.isNavigationRequest() && request.frame() === currentPage.mainFrame()
            && ++navigations > this.config.MAX_REDIRECTS + 1) throw new CrawlError('REDIRECT_FAILED', 'The browser navigation limit was exceeded.');
          if (['media', 'font'].includes(request.resourceType())) { await route.abort(); return; }
          await route.continue();
        } catch (error) {
          fail(normalizeCrawlError(error));
          await route.abort().catch(() => {});
        }
      });
      currentPage.on('response', (response) => {
        if (response.request().isNavigationRequest() && response.frame() === currentPage.mainFrame()) {
          finalResponse = { url: response.url(), status: response.status(), headers: response.headers() };
        }
      });
      currentPage.on('download', (download) => { void download.cancel(); fail(new CrawlError('UNSUPPORTED_CONTENT', 'File downloads are not supported.')); });
      const cdp = await lease.value.context.newCDPSession(currentPage);
      await cdp.send('Network.enable');
      cdp.on('Network.dataReceived', (event: { dataLength: number }) => {
        decodedBytes += event.dataLength;
        if (decodedBytes > this.config.MAX_BROWSER_NETWORK_BYTES) fail(new CrawlError('RESPONSE_TOO_LARGE', 'The decoded browser network budget was exceeded.'));
      });
      await currentPage.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(1, Math.min(this.config.BROWSER_TIMEOUT_MS, context.deadline - Date.now())) });
      let stableSince = Date.now();
      let previousHtml = '';
      for (;;) {
        signal.throwIfAborted();
        if (guard.failure) throw guard.failure;
        if (failure) throw failure;
        if (!finalResponse) throw new CrawlError('FETCH_FAILED', 'No main-document response was received.');
        const html = await currentPage.content();
        if (Buffer.byteLength(html) > this.config.MAX_RESPONSE_BYTES) throw new CrawlError('RESPONSE_TOO_LARGE', 'The rendered document exceeds the configured byte limit.');
        const result: RetrievedPage = { html, finalUrl: currentPage.url(), upstreamStatus: finalResponse.status,
          headers: finalResponse.headers, contentType: finalResponse.headers['content-type']?.split(';')[0]?.trim() ?? '', strategy: 'browser' };
        if (!['text/html', 'application/xhtml+xml'].includes(result.contentType)) throw new CrawlError('UNSUPPORTED_CONTENT', 'Destination must return HTML or XHTML.');
        const assessment = classifyResponse(result);
        if (assessment.kind === 'USABLE_CONTENT') {
          if (html !== previousHtml) { previousHtml = html; stableSince = Date.now(); }
          if (Date.now() - stableSince >= 300) { discard = false; return result; }
        } else if (['BROWSER_CHALLENGE', 'CAPTCHA_REQUIRED', 'LOGIN_REQUIRED', 'RATE_LIMITED', 'UPSTREAM_ERROR', 'BOT_BLOCKED'].includes(assessment.kind)) {
          return result;
        } else { previousHtml = ''; stableSince = Date.now(); }
        await delay(100, undefined, { signal });
      }
    } catch (error) {
      if (signal.aborted) throw normalizeCrawlError(signal.reason);
      if (guard?.failure) throw guard.failure;
      if (failure) throw failure;
      throw normalizeCrawlError(error);
    } finally {
      if (abort) signal.removeEventListener('abort', abort);
      await page?.close().catch(() => {});
      cleanupGuard?.();
      await release?.(discard);
      this.active--;
    }
  }

  async close(): Promise<void> {
    await this.sessions.close();
    const browser = await this.runtime?.catch(() => undefined);
    await browser?.close();
    this.runtime = undefined;
  }
}
