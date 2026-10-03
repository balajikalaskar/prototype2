import type { ErrorRequestHandler } from 'express';
import type { Logger } from 'pino';

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, _req, res, next) => {
    if (res.headersSent) { next(error); return; }
    const status = typeof error === 'object' && error !== null && 'status' in error
      ? Number(error.status) : 500;
    const clientStatus = status >= 400 && status < 500 ? status : 500;
    logger.error({ requestId: res.locals.requestId, status: clientStatus }, 'HTTP-level error');
    res.status(clientStatus).json({ error: clientStatus === 413 ? 'Request body too large.'
      : clientStatus === 400 ? 'Invalid request body.' : 'An internal error occurred.' });
  };
}
