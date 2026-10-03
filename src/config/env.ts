import { z } from 'zod';

const integer = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

export const envSchema = z.object({
  PORT: integer(3000, 1, 65535),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CRAWL_TIMEOUT_MS: integer(10000, 100, 60000),
  MAX_CONCURRENT_CRAWLS: integer(5, 1, 100),
  MAX_RESPONSE_BYTES: integer(2097152, 1024, 10485760),
  MAX_TEXT_LENGTH: integer(50000, 1, 1000000),
  MAX_LINKS: integer(100, 1, 1000),
  MAX_HEADINGS: integer(100, 1, 1000),
  MAX_REDIRECTS: integer(5, 0, 10),
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
