import express from 'express';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import type { Logger } from 'pino';
import { errorHandler } from '../middleware/error-handler.js';
import { requestLogger } from '../middleware/request-logger.js';
import type { CrawlerService } from '../services/crawler.service.js';
import { createContext } from '../trpc/context.js';
import { appRouter } from '../trpc/router.js';

export function createApp(crawlerService: CrawlerService, logger: Logger) {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestLogger(logger));
  app.get('/health', (_req, res) => { res.json({ status: 'ok' }); });
  app.use('/trpc', express.json({ limit: '16kb' }), createExpressMiddleware({
    router: appRouter,
    createContext: createContext(crawlerService, logger),
    onError({ error, ctx, path }) {
      logger[error.code === 'INTERNAL_SERVER_ERROR' ? 'error' : 'debug']({
        requestId: ctx?.requestId, path, code: error.code,
      }, 'tRPC procedure failed');
    },
  }));
  app.use((_req, res) => { res.status(404).json({ error: 'Not found.' }); });
  app.use(errorHandler(logger));
  return app;
}
