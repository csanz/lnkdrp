// cron.stripe-credits-report — runs the `/api/cron/stripe-credits-report` job. Vercel schedule: 30 * * * *
// Usage: npm run cron:stripe-credits-report -- [--dry-run] [--limit=N] [--target=https://lnkdrp.com]
import { runCronJob } from "./lib";

void runCronJob("stripe-credits-report");
