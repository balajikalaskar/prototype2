import { crawlerRouter } from '../routers/crawler.router.js';
import { router } from './init.js';

export const appRouter = router({ crawler: crawlerRouter });
export type AppRouter = typeof appRouter;
