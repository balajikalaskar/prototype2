import 'dotenv/config';
import { loadConfig } from '../config/env.js';
import { createLogger } from '../config/logger.js';
import { CrawlerService } from '../services/crawler.service.js';
import { createApp } from './create-app.js';

const config = loadConfig();
const logger = createLogger(config);
const crawlerService = new CrawlerService(config, logger);
const app = createApp(crawlerService, logger);
const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, node: process.version }, 'Crawler API listening');
});
server.requestTimeout = config.CRAWL_TIMEOUT_MS + 5000;
server.headersTimeout = 10000;
server.on('error', (error) => {
  logger.fatal({ err: error }, 'Server failed');
  void crawlerService.close().finally(() => { process.exitCode = 1; });
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');
  const forceExit = setTimeout(() => {
    server.closeAllConnections();
    logger.error('Shutdown grace period exceeded');
    process.exit(1);
  }, config.CRAWL_TIMEOUT_MS + 5000);
  forceExit.unref();
  const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  try {
    await crawlerService.close();
    await closed;
  } catch (error) {
    logger.error({ err: error }, 'Shutdown failed');
    process.exitCode = 1;
  } finally { clearTimeout(forceExit); }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => { void shutdown(signal); });
}
