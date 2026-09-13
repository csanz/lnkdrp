// cron.usage-agg-reconcile — runs the `/api/cron/usage-agg-reconcile` job. Vercel schedule: 20 * * * *
// Usage: npm run cron:usage-agg-reconcile -- [--dry-run] [--limit=N] [--target=https://lnkdrp.com]
import { runCronJob } from "./lib";

void runCronJob("usage-agg-reconcile");
