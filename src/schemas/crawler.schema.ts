import { z } from 'zod';
import { parseHttpUrl } from '../utils/url.js';

export const crawlInputSchema = z.object({
  url: z.string().min(1).max(2048).refine((value) => {
    try { parseHttpUrl(value); return true; } catch { return false; }
  }, 'Provide an absolute HTTP/HTTPS URL without credentials.'),
  mode: z.enum(['auto', 'http', 'tls', 'browser']).optional(),
});

export type CrawlInput = z.infer<typeof crawlInputSchema>;
