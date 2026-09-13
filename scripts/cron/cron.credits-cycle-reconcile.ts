// cron.credits-cycle-reconcile — runs the `/api/cron/credits-cycle-reconcile` job. Vercel schedule: 10 * * * *
// Usage: npm run cron:credits-cycle-reconcile -- [--dry-run] [--limit=N] [--target=https://lnkdrp.com]
import { runCronJob } from "./lib";

void runCronJob("credits-cycle-reconcile");
