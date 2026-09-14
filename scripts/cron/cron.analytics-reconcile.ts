// cron.analytics-reconcile — runs the `/api/cron/analytics-reconcile` job. Vercel schedule: 50 3 * * *
// Usage: npm run cron:analytics-reconcile -- [--dry-run] [--target=https://lnkdrp.com]
import { runCronJob } from "./lib";

void runCronJob("analytics-reconcile");
