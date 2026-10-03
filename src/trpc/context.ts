import type { CreateExpressContextOptions } from '@trpc/server/adapters/express';
import type { Logger } from 'pino';
import type { CrawlerService } from '../services/crawler.service.js';

export interface Context {
  crawlerService: CrawlerService;
  logger: Logger;
  requestId: string;
}

export const createContext = (crawlerService: CrawlerService, logger: Logger) =>
  ({ res }: CreateExpressContextOptions): Context => ({
    crawlerService, logger, requestId: String(res.locals.requestId),
  });
