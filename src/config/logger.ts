import { pino } from 'pino';
import type { AppConfig } from './env.js';

export function createLogger(config: AppConfig) {
  return pino({ level: config.LOG_LEVEL, base: { service: 'crawler-prototype2' } });
}
