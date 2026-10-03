export type CrawlErrorKind =
  | 'INVALID_URL' | 'DISALLOWED_DESTINATION' | 'FETCH_FAILED' | 'TIMEOUT'
  | 'REDIRECT_FAILED' | 'UNSUPPORTED_CONTENT' | 'RESPONSE_TOO_LARGE'
  | 'UPSTREAM_HTTP_ERROR' | 'PARSING_FAILED' | 'CAPACITY_EXHAUSTED'
  | 'SHUTTING_DOWN' | 'INTERNAL_ERROR';

export class CrawlError extends Error {
  constructor(public readonly kind: CrawlErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CrawlError';
  }
}

export function normalizeCrawlError(error: unknown): CrawlError {
  if (error instanceof CrawlError) return error;
  if (error instanceof Error) {
    // Got wraps errors thrown by hooks; keep the original classified failure.
    if (error.cause instanceof CrawlError) return error.cause;
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return new CrawlError('TIMEOUT', 'The crawl exceeded its deadline.', { cause: error });
    }
    if (error.name === 'MaxRedirectsError') {
      return new CrawlError('REDIRECT_FAILED', 'The redirect limit was exceeded.', { cause: error });
    }
    if (error.name === 'ParseError' || error.name === 'SyntaxError') {
      return new CrawlError('PARSING_FAILED', 'Unable to parse the destination response.', { cause: error });
    }
    if (error.name === 'RequestError' || error.name === 'ReadError'
      || ('code' in error && typeof error.code === 'string' && /^(E[A-Z]+|ERR_TLS_|ERR_SSL_)/.test(error.code))) {
      return new CrawlError('FETCH_FAILED', 'Unable to fetch the destination.', { cause: error });
    }
  }
  return new CrawlError('INTERNAL_ERROR', 'An internal error occurred.', { cause: error });
}
