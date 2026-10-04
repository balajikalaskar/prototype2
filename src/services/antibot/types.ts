import type { CheerioAPI } from 'cheerio' with { 'resolution-mode': 'require' };

export type StrategyName = 'http' | 'tls' | 'browser';
export type AssessmentKind = 'USABLE_CONTENT' | 'BOT_BLOCKED' | 'BROWSER_CHALLENGE'
  | 'JAVASCRIPT_REQUIRED' | 'CAPTCHA_REQUIRED' | 'RATE_LIMITED' | 'LOGIN_REQUIRED' | 'UPSTREAM_ERROR';

export interface RetrievedPage {
  html: string;
  finalUrl: string;
  upstreamStatus: number;
  contentType: string;
  headers: Record<string, string | string[] | undefined>;
  strategy: StrategyName;
  parsed?: CheerioAPI;
}

export interface RetrievalContext {
  signal: AbortSignal;
  deadline: number;
}

export interface Assessment {
  kind: AssessmentKind;
  provider?: string;
  retryAfterMs?: number;
}
