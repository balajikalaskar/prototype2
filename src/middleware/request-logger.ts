import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { RequestHandler } from 'express';
import type { Logger } from 'pino';

export function requestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const started = performance.now();
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    res.on('finish', () => {
      logger.info({ requestId, method: req.method, path: req.path, status: res.statusCode,
        durationMs: Math.round((performance.now() - started) * 100) / 100 }, 'HTTP request');
    });
    next();
  };
}
