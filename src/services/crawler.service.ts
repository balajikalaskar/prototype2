import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { performance } from 'node:perf_hooks';
import { CheerioCrawler } from '@crawlee/cheerio';
import { Configuration, Log, LogLevel, RequestList } from '@crawlee/core';
import { MemoryStorage } from '@crawlee/memory-storage';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/env.js';
import { InMemoryConfiguration } from '../config/crawlee.js';
import { crawlInputSchema, type CrawlInput } from '../schemas/crawler.schema.js';
import type { CrawlResult } from '../types/crawler.types.js';
import { secureDestination } from '../utils/url.js';
import { BoundedHttpClient } from './bounded-http-client.js';
import { CrawlError, normalizeCrawlError } from './crawl-error.js';
import { extractPage } from './extraction.service.js';

export class CrawlerService {
  private readonly active = new Map<AbortController, Promise<void>>();
  private closing = false;
  private readonly httpClient: BoundedHttpClient;
  private readonly httpAgent: HttpAgent;
  private readonly httpsAgent: HttpsAgent;

  constructor(private readonly config: AppConfig, private readonly logger: Logger) {
    this.httpClient = new BoundedHttpClient(config.MAX_RESPONSE_BYTES);
    const agentOptions = { keepAlive: true, maxSockets: config.MAX_CONCURRENT_CRAWLS, maxTotalSockets: config.MAX_CONCURRENT_CRAWLS, maxFreeSockets: 2 };
    this.httpAgent = new HttpAgent(agentOptions);
    this.httpsAgent = new HttpsAgent(agentOptions);
  }

  async crawl(input: CrawlInput): Promise<CrawlResult> {
    const validated = crawlInputSchema.safeParse(input);
    if (!validated.success) throw new CrawlError('INVALID_URL', 'Provide a valid HTTP/HTTPS URL without credentials.');
    if (this.closing) throw new CrawlError('SHUTTING_DOWN', 'The crawler is shutting down.');
    if (this.active.size >= this.config.MAX_CONCURRENT_CRAWLS) {
      throw new CrawlError('CAPACITY_EXHAUSTED', 'Crawl capacity is full. Try again later.');
    }
    const started = performance.now();
    const controller = new AbortController();
    let complete!: () => void;
    this.active.set(controller, new Promise<void>((resolve) => { complete = resolve; }));
    const timeoutError = new CrawlError('TIMEOUT', 'The crawl exceeded its deadline.');
    const timer = setTimeout(() => controller.abort(timeoutError), this.config.CRAWL_TIMEOUT_MS);
    timer.unref();
    try {
      const result = await this.runSinglePage(validated.data.url, controller.signal);
      controller.signal.throwIfAborted();
      result.meta.durationMs = Math.round((performance.now() - started) * 100) / 100;
      this.logger.debug({ durationMs: result.meta.durationMs, httpStatus: result.httpStatus }, 'Crawl completed');
      return result;
    } catch (error) {
      const failure = controller.signal.aborted
        ? normalizeCrawlError(controller.signal.reason)
        : normalizeCrawlError(error);
      this.logger.warn({ kind: failure.kind, origin: new URL(validated.data.url).origin,
        errorName: failure.cause instanceof Error ? failure.cause.name : undefined,
        durationMs: Math.round(performance.now() - started) }, 'Crawl failed');
      throw failure;
    } finally {
      clearTimeout(timer);
      this.active.delete(controller);
      complete();
    }
  }

  private async runSinglePage(url: string, signal: AbortSignal): Promise<CrawlResult> {
    // A distinct config and static request list avoid Crawlee's shared default queue and result state.
    const storage = new MemoryStorage({ persistStorage: false, writeMetadata: false });
    const config = new InMemoryConfiguration({
      persistStorage: false, purgeOnStart: false, storageClient: storage,
    });
    const requestList = await Configuration.storage.run(config, () => RequestList.open(null, [{ url }]));
    let result: CrawlResult | undefined;
    let failure: unknown;
    const crawler = new CheerioCrawler({
      requestList,
      httpClient: this.httpClient,
      maxRequestsPerCrawl: 1,
      maxRequestRetries: 0,
      useSessionPool: false,
      retryOnBlocked: false,
      respectRobotsTxtFile: false,
      minConcurrency: 1,
      maxConcurrency: 1,
      navigationTimeoutSecs: this.config.CRAWL_TIMEOUT_MS / 1000,
      requestHandlerTimeoutSecs: this.config.CRAWL_TIMEOUT_MS / 1000,
      autoscaledPoolOptions: { desiredConcurrency: 1, maybeRunIntervalSecs: 0.01 },
      log: new Log({ level: LogLevel.OFF }),
      preNavigationHooks: [async (_context, options) => {
        signal.throwIfAborted();
        options.signal = signal;
        options.retry = { limit: 0 };
        options.maxRedirects = this.config.MAX_REDIRECTS;
        options.http2 = false;
        options.dnsCache = false;
        options.useHeaderGenerator = false;
        options.agent = { http: this.httpAgent, https: this.httpsAgent };
        options.headers = { 'user-agent': 'CrawlerPrototype/0.1', accept: 'text/html, application/xhtml+xml' };
        options.hooks = {
          beforeRequest: [(requestOptions) => secureDestination(requestOptions, signal)],
          beforeRedirect: [(requestOptions) => secureDestination(requestOptions, signal)],
        };
      }],
      requestHandler: ({ $, request, response }) => {
        signal.throwIfAborted();
        const httpStatus = response.statusCode;
        if (httpStatus === undefined) throw new CrawlError('INTERNAL_ERROR', 'The response did not include an HTTP status.');
        try {
          const finalUrl = request.loadedUrl ?? request.url;
          const { textTruncated, linksTruncated, headingsTruncated, ...content } = extractPage($, finalUrl, {
            maxTextLength: this.config.MAX_TEXT_LENGTH,
            maxLinks: this.config.MAX_LINKS,
            maxHeadings: this.config.MAX_HEADINGS,
          });
          result = {
            url, finalUrl, httpStatus, ...content,
            meta: { durationMs: 0, fetchedAt: new Date().toISOString(), textTruncated, linksTruncated, headingsTruncated },
          };
        } catch (error) {
          if (error instanceof CrawlError) throw error;
          throw new CrawlError('PARSING_FAILED', 'Unable to extract page content.', { cause: error });
        }
      },
      failedRequestHandler: (_context, error) => { failure = error; },
    }, config);

    try {
      signal.throwIfAborted();
      await crawler.run();
      if (failure) throw failure;
      if (!result) throw new CrawlError('INTERNAL_ERROR', 'The crawl did not produce a result.');
      return result;
    } finally {
      // run() normally tears down itself; this also covers errors during initialization.
      try { await crawler.teardown(); }
      finally { await storage.teardown(); }
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.active.keys()) {
      controller.abort(new CrawlError('SHUTTING_DOWN', 'The crawler is shutting down.'));
    }
    await Promise.all(this.active.values());
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }
}
