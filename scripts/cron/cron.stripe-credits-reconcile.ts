// cron.stripe-credits-reconcile — runs the `/api/cron/stripe-credits-reconcile` job. Vercel schedule: 15 */6 * * *
// Usage: npm run cron:stripe-credits-reconcile -- [--dry-run] [--limit=N] [--target=https://lnkdrp.com]
import { runCronJob } from "./lib";

void runCronJob("stripe-credits-reconcile");
