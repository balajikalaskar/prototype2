import { z } from 'zod';

const integer = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

export const envSchema = z.object({
  PORT: integer(3000, 1, 65535),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CRAWL_TIMEOUT_MS: integer(30000, 100, 120000),
  MAX_CONCURRENT_CRAWLS: integer(5, 1, 100),
  MAX_RESPONSE_BYTES: integer(2097152, 1024, 10485760),
  MAX_TEXT_LENGTH: integer(50000, 1, 1000000),
  MAX_LINKS: integer(100, 1, 1000),
  MAX_HEADINGS: integer(100, 1, 1000),
  MAX_REDIRECTS: integer(5, 0, 10),
  HTTP_TIMEOUT_MS: integer(8000, 100, 60000),
  BROWSER_TIMEOUT_MS: integer(15000, 100, 60000),
  MAX_STRATEGY_ATTEMPTS: integer(3, 1, 3),
  MAX_BROWSER_CONCURRENCY: integer(2, 1, 10),
  MAX_SESSIONS: integer(10, 1, 50),
  SESSION_TTL_MS: integer(300000, 1000, 3600000),
  MAX_BROWSER_REQUESTS: integer(100, 1, 500),
  MAX_BROWSER_NETWORK_BYTES: integer(8388608, 1024, 52428800),
  TLS_BROWSER_PROFILE: z.enum(['chrome151', 'chrome142', 'firefox144']).default('chrome151'),
  BROWSER_ENABLED: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  PROXY_URL: z.string().url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol),
    'Only HTTP/HTTPS upstream proxies are supported.').optional(),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  return parsed.data;
}
