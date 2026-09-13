// cron.doc-metrics — runs the `/api/cron/doc-metrics` job. Vercel schedule: 0 */6 * * *
// Usage: npm run cron:doc-metrics -- [--dry-run] [--limit=N] [--target=https://lnkdrp.com]
import { runCronJob } from "./lib";

void runCronJob("doc-metrics");
