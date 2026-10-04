import { performance } from 'node:perf_hooks';
import type { Logger } from 'pino';
import type { AppConfig } from '../../config/env.js';
import type { CrawlInput } from '../../schemas/crawler.schema.js';
import { CrawlError, normalizeCrawlError } from '../crawl-error.js';
import { BrowserStrategy } from './browser.strategy.js';
import { HttpStrategy } from './http.strategy.js';
import { classifyResponse } from './response-classifier.js';
import { TlsHttpStrategy } from './tls-http.strategy.js';
import type { Assessment, RetrievedPage, RetrievalContext, StrategyName } from './types.js';

export class AntibotService {
  private readonly http: HttpStrategy;
  private readonly tls: TlsHttpStrategy;
  private readonly browser: BrowserStrategy;
  private readonly hints = new Map<string, { strategy: StrategyName; expires: number }>();

  constructor(private readonly config: AppConfig, private readonly logger: Logger) {
    this.http = new HttpStrategy(config);
    this.tls = new TlsHttpStrategy(config);
    this.browser = new BrowserStrategy(config);
  }

  async retrieve(input: CrawlInput, context: RetrievalContext) {
    const started = performance.now();
    const keyUrl = new URL(input.url);
    keyUrl.hash = '';
    const key = keyUrl.href; // Path/query specific: one successful URL does not label an entire domain.
    const hint = this.hints.get(key);
    if (hint && hint.expires <= Date.now()) this.hints.delete(key);
    const mode = input.mode ?? 'auto';
    const first = mode === 'auto' && hint && hint.expires > Date.now() ? hint.strategy : 'http';
    const strategies: StrategyName[] = mode === 'auto'
      ? first === 'browser' ? ['browser', 'tls'] : first === 'tls' ? ['tls', 'browser'] : ['http', 'tls', 'browser']
      : [mode];
    const attempts: StrategyName[] = [];
    let lastError: CrawlError | undefined;
    for (const strategy of strategies.slice(0, this.config.MAX_STRATEGY_ATTEMPTS)) {
      context.signal.throwIfAborted();
      attempts.push(strategy);
      const stageStarted = performance.now();
      try {
        // With a configured proxy, even the HTTP tier must traverse the guarded proxy path.
        const page = strategy === 'http' && !this.config.PROXY_URL
          ? await this.http.retrieve(input.url, context)
          : strategy === 'browser' ? await this.browser.retrieve(input.url, context)
            : await this.tls.retrieve(input.url, context);
        const assessment = classifyResponse(page);
        this.logger.debug({ strategy: page.strategy, upstreamStatus: page.upstreamStatus,
          classification: assessment.kind, durationMs: Math.round(performance.now() - stageStarted) }, 'Retrieval attempt');
        if (assessment.kind === 'USABLE_CONTENT') {
          if (this.hints.size >= this.config.MAX_SESSIONS * 10) this.hints.delete(this.hints.keys().next().value!);
          this.hints.set(key, { strategy: page.strategy, expires: Date.now() + this.config.SESSION_TTL_MS });
          return { page, attemptCount: attempts.length, retrievalDurationMs: Math.round((performance.now() - started) * 100) / 100 };
        }
        throw this.assessmentError(page, assessment);
      } catch (error) {
        lastError = normalizeCrawlError(error);
        lastError.diagnostics.attemptedStrategies = [...attempts];
        if (mode !== 'auto' || !['BOT_BLOCKED', 'BROWSER_CHALLENGE', 'JAVASCRIPT_REQUIRED'].includes(lastError.kind)) throw lastError;
        this.hints.delete(key);
      }
    }
    throw lastError ?? new CrawlError('BOT_BLOCKED', 'The configured retrieval attempts did not obtain the page.');
  }

  private assessmentError(page: RetrievedPage, assessment: Assessment): CrawlError {
    const messages = {
      BOT_BLOCKED: 'The website blocked all attempted retrieval strategies.',
      BROWSER_CHALLENGE: 'The website still requires browser verification.',
      JAVASCRIPT_REQUIRED: 'The page requires JavaScript execution.',
      CAPTCHA_REQUIRED: 'An active CAPTCHA gate prevents access. CAPTCHA solving is not enabled.',
      RATE_LIMITED: 'The destination rate-limited this request. Retry after the indicated interval.',
      LOGIN_REQUIRED: 'The requested page requires a login.',
      UPSTREAM_ERROR: `Destination returned HTTP ${page.upstreamStatus}.`,
      USABLE_CONTENT: 'The page was retrieved.',
    };
    return new CrawlError(assessment.kind === 'UPSTREAM_ERROR' ? 'UPSTREAM_HTTP_ERROR'
      : assessment.kind === 'USABLE_CONTENT' ? 'INTERNAL_ERROR' : assessment.kind,
    messages[assessment.kind], undefined, { upstreamStatus: page.upstreamStatus, blockType: assessment.kind,
      provider: assessment.provider, retryAfterMs: assessment.retryAfterMs });
  }

  async close(): Promise<void> {
    await Promise.all([this.http.close(), this.tls.close(), this.browser.close()]);
    this.hints.clear();
  }
}
