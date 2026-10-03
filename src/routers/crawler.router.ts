import { TRPCError } from '@trpc/server';
import { crawlInputSchema } from '../schemas/crawler.schema.js';
import { CrawlError, type CrawlErrorKind } from '../services/crawl-error.js';
import { publicProcedure, router } from '../trpc/init.js';

const errorCodes = {
  INVALID_URL: 'BAD_REQUEST',
  DISALLOWED_DESTINATION: 'FORBIDDEN',
  FETCH_FAILED: 'BAD_GATEWAY',
  TIMEOUT: 'TIMEOUT',
  REDIRECT_FAILED: 'BAD_GATEWAY',
  UNSUPPORTED_CONTENT: 'UNSUPPORTED_MEDIA_TYPE',
  RESPONSE_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UPSTREAM_HTTP_ERROR: 'BAD_GATEWAY',
  PARSING_FAILED: 'UNPROCESSABLE_CONTENT',
  CAPACITY_EXHAUSTED: 'TOO_MANY_REQUESTS',
  SHUTTING_DOWN: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_SERVER_ERROR',
} as const satisfies Record<CrawlErrorKind, TRPCError['code']>;

export const crawlerRouter = router({
  crawl: publicProcedure.input(crawlInputSchema).mutation(async ({ input, ctx }) => {
    try { return await ctx.crawlerService.crawl(input); }
    catch (error) {
      if (error instanceof CrawlError) {
        throw new TRPCError({ code: errorCodes[error.kind], message: error.message, cause: error });
      }
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'An internal error occurred.', cause: error });
    }
  }),
});
