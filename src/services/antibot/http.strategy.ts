import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { CheerioCrawler } from '@crawlee/cheerio';
import { Configuration, Log, LogLevel, RequestList } from '@crawlee/core';
import { MemoryStorage } from '@crawlee/memory-storage';
import type { AppConfig } from '../../config/env.js';
import { InMemoryConfiguration } from '../../config/crawlee.js';
import { secureDestination } from '../../utils/url.js';
import { BoundedHttpClient } from '../bounded-http-client.js';
import { CrawlError, normalizeCrawlError } from '../crawl-error.js';
import { stageSignal } from './helpers.js';
import type { RetrievalContext, RetrievedPage } from './types.js';

export class HttpStrategy {
  private readonly client: BoundedHttpClient;
  private readonly httpAgent: HttpAgent;
  private readonly httpsAgent: HttpsAgent;

  constructor(private readonly config: AppConfig) {
    this.client = new BoundedHttpClient(config.MAX_RESPONSE_BYTES);
    const options = { keepAlive: true, maxSockets: config.MAX_CONCURRENT_CRAWLS,
      maxTotalSockets: config.MAX_CONCURRENT_CRAWLS, maxFreeSockets: 2 };
    this.httpAgent = new HttpAgent(options);
    this.httpsAgent = new HttpsAgent(options);
  }

  async retrieve(url: string, context: RetrievalContext): Promise<RetrievedPage> {
    const signal = stageSignal(context, this.config.HTTP_TIMEOUT_MS);
    const storage = new MemoryStorage({ persistStorage: false, writeMetadata: false });
    const config = new InMemoryConfiguration({ persistStorage: false, purgeOnStart: false, storageClient: storage });
    const requestList = await Configuration.storage.run(config, () => RequestList.open(null, [{ url }]));
    let result: RetrievedPage | undefined;
    let failure: unknown;
    const crawler = new CheerioCrawler({ requestList, httpClient: this.client,
      maxRequestsPerCrawl: 1, maxRequestRetries: 0, useSessionPool: false, retryOnBlocked: false,
      respectRobotsTxtFile: false, minConcurrency: 1, maxConcurrency: 1,
      ignoreHttpErrorStatusCodes: [403, 429, 503], additionalMimeTypes: ['text/plain'],
      navigationTimeoutSecs: this.config.HTTP_TIMEOUT_MS / 1000,
      requestHandlerTimeoutSecs: this.config.HTTP_TIMEOUT_MS / 1000,
      autoscaledPoolOptions: { desiredConcurrency: 1, maybeRunIntervalSecs: 0.01 },
      log: new Log({ level: LogLevel.OFF }),
      preNavigationHooks: [(_context, options) => {
        signal.throwIfAborted();
        options.signal = signal;
        options.retry = { limit: 0 };
        options.maxRedirects = this.config.MAX_REDIRECTS;
        options.http2 = false;
        options.dnsCache = false;
        options.useHeaderGenerator = false;
        options.agent = { http: this.httpAgent, https: this.httpsAgent };
        options.headers = { 'user-agent': 'CrawlerPrototype/0.1', accept: 'text/html, application/xhtml+xml' };
        options.hooks = { beforeRequest: [(options) => secureDestination(options, signal)],
          beforeRedirect: [(options) => secureDestination(options, signal)] };
      }],
      requestHandler: ({ $, request, response, body, contentType }) => {
        signal.throwIfAborted();
        if (!response.statusCode) throw new CrawlError('INTERNAL_ERROR', 'Missing upstream status.');
        result = { html: body.toString(), parsed: $, finalUrl: request.loadedUrl ?? request.url,
          upstreamStatus: response.statusCode, contentType: contentType.type,
          headers: response.headers, strategy: 'http' };
      },
      failedRequestHandler: (_context, error) => { failure = error; },
    }, config);
    try {
      signal.throwIfAborted();
      await crawler.run();
      signal.throwIfAborted();
      if (failure) throw failure;
      if (!result) throw new CrawlError('INTERNAL_ERROR', 'The crawl did not produce a result.');
      return result;
    } catch (error) { throw normalizeCrawlError(signal.aborted ? signal.reason : error); }
    finally { try { await crawler.teardown(); } finally { await storage.teardown(); } }
  }

  async close(): Promise<void> { this.httpAgent.destroy(); this.httpsAgent.destroy(); }
}
