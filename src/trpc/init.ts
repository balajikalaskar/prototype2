import { initTRPC } from '@trpc/server';
import { CrawlError } from '../services/crawl-error.js';
import type { Context } from './context.js';

const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    const { stack: _stack, ...data } = shape.data;
    return {
      ...shape,
      message: error.code === 'INTERNAL_SERVER_ERROR' ? 'An internal error occurred.' : shape.message,
      data: { ...data, reason: error.cause instanceof CrawlError ? error.cause.kind : null,
        ...(error.cause instanceof CrawlError ? error.cause.diagnostics : {}) },
    };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;
