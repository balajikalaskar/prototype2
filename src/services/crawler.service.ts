import { performance } from 'node:perf_hooks';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/env.js';
import { crawlInputSchema, type CrawlInput } from '../schemas/crawler.schema.js';
import type { CrawlResult } from '../types/crawler.types.js';
import { AntibotService } from './antibot/antibot.service.js';
import { cheerio } from './antibot/helpers.js';
import { CrawlError, normalizeCrawlError } from './crawl-error.js';
import { extractPage } from './extraction.service.js';

export class CrawlerService {
  private readonly active = new Map<AbortController, Promise<void>>();
  private readonly antibot: AntibotService;
  private closing = false;

  constructor(private readonly config: AppConfig, private readonly logger: Logger) {
    this.antibot = new AntibotService(config, logger);
  }

  async crawl(input: CrawlInput): Promise<CrawlResult> {
    const validated = crawlInputSchema.safeParse(input);
    if (!validated.success) throw new CrawlError('INVALID_URL', 'Provide a valid HTTP/HTTPS URL without credentials.');
    if (this.closing) throw new CrawlError('SHUTTING_DOWN', 'The crawler is shutting down.');
    if (this.active.size >= this.config.MAX_CONCURRENT_CRAWLS) throw new CrawlError('CAPACITY_EXHAUSTED', 'Crawl capacity is full. Try again later.');
    const started = performance.now();
    const controller = new AbortController();
    let complete!: () => void;
    this.active.set(controller, new Promise<void>((resolve) => { complete = resolve; }));
    const timer = setTimeout(() => controller.abort(new CrawlError('TIMEOUT', 'The crawl exceeded its deadline.')), this.config.CRAWL_TIMEOUT_MS);
    timer.unref();
    try {
      const { page, attemptCount, retrievalDurationMs } = await this.antibot.retrieve(validated.data,
        { signal: controller.signal, deadline: Date.now() + this.config.CRAWL_TIMEOUT_MS });
      controller.signal.throwIfAborted();
      const extractionStarted = performance.now();
      const { textTruncated, linksTruncated, headingsTruncated, ...content } = extractPage(page.parsed ?? cheerio.load(page.html), page.finalUrl, {
        maxTextLength: this.config.MAX_TEXT_LENGTH, maxLinks: this.config.MAX_LINKS, maxHeadings: this.config.MAX_HEADINGS,
      });
      controller.signal.throwIfAborted();
      return { url: input.url, finalUrl: page.finalUrl, httpStatus: page.upstreamStatus, ...content,
        meta: { durationMs: Math.round((performance.now() - started) * 100) / 100, fetchedAt: new Date().toISOString(),
          textTruncated, linksTruncated, headingsTruncated, strategy: page.strategy, rendered: page.strategy === 'browser',
          attemptCount, retrievalDurationMs, extractionDurationMs: Math.round((performance.now() - extractionStarted) * 100) / 100 } };
    } catch (error) {
      const failure = normalizeCrawlError(controller.signal.aborted ? controller.signal.reason : error);
      this.logger.warn({ kind: failure.kind, origin: new URL(validated.data.url).origin,
        ...failure.diagnostics, durationMs: Math.round(performance.now() - started) }, 'Crawl failed');
      throw failure;
    } finally { clearTimeout(timer); this.active.delete(controller); complete(); }
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.active.keys()) controller.abort(new CrawlError('SHUTTING_DOWN', 'The crawler is shutting down.'));
    await Promise.all(this.active.values());
    await this.antibot.close();
  }
}
