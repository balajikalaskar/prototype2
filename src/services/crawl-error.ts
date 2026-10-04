export type CrawlErrorKind =
  | 'INVALID_URL' | 'DISALLOWED_DESTINATION' | 'FETCH_FAILED' | 'TIMEOUT'
  | 'REDIRECT_FAILED' | 'UNSUPPORTED_CONTENT' | 'RESPONSE_TOO_LARGE'
  | 'UPSTREAM_HTTP_ERROR' | 'PARSING_FAILED' | 'CAPACITY_EXHAUSTED'
  | 'SHUTTING_DOWN' | 'INTERNAL_ERROR' | 'BOT_BLOCKED' | 'BROWSER_CHALLENGE'
  | 'JAVASCRIPT_REQUIRED' | 'CAPTCHA_REQUIRED' | 'RATE_LIMITED' | 'LOGIN_REQUIRED'
  | 'BROWSER_UNAVAILABLE' | 'PROXY_ERROR';

export interface CrawlDiagnostics {
  upstreamStatus?: number;
  blockType?: string;
  attemptedStrategies?: string[];
  retryAfterMs?: number;
  provider?: string;
}

export class CrawlError extends Error {
  constructor(public readonly kind: CrawlErrorKind, message: string, options?: ErrorOptions,
    public readonly diagnostics: CrawlDiagnostics = {}) {
    super(message, options);
    this.name = 'CrawlError';
  }
}

export function normalizeCrawlError(error: unknown): CrawlError {
  if (error instanceof CrawlError) return error;
  if (error instanceof Error) {
    // Got wraps errors thrown by hooks; keep the original classified failure.
    if (error.cause instanceof CrawlError) return error.cause;
    if (/Timeout|Abort/.test(error.name)) {
      return new CrawlError('TIMEOUT', 'The crawl exceeded its deadline.', { cause: error });
    }
    if (error.name === 'MaxRedirectsError' || error.name === 'TooManyRedirects') {
      return new CrawlError('REDIRECT_FAILED', 'The redirect limit was exceeded.', { cause: error });
    }
    if (error.name === 'ParseError' || error.name === 'SyntaxError') {
      return new CrawlError('PARSING_FAILED', 'Unable to parse the destination response.', { cause: error });
    }
    if (/net::ERR_|Target page, context or browser has been closed/.test(error.message)) {
      return new CrawlError('FETCH_FAILED', 'Browser navigation failed.', { cause: error });
    }
    if (/Proxy/.test(error.name)) return new CrawlError('PROXY_ERROR', 'The configured proxy failed.', { cause: error });
    if (['RequestError', 'ReadError', 'NetworkError', 'ConnectError', 'TransportError', 'ProtocolError', 'RemoteProtocolError'].includes(error.name)
      || ('code' in error && typeof error.code === 'string' && /^(E[A-Z]+|ERR_TLS_|ERR_SSL_)/.test(error.code))) {
      return new CrawlError('FETCH_FAILED', 'Unable to fetch the destination.', { cause: error });
    }
  }
  return new CrawlError('INTERNAL_ERROR', 'An internal error occurred.', { cause: error });
}
