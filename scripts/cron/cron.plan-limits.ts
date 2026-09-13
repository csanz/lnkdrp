// cron.plan-limits — runs the `/api/cron/plan-limits` job. Vercel schedule: 40 * * * *
// Usage: npm run cron:plan-limits -- [--dry-run] [--limit=N] [--target=https://lnkdrp.com]
import { runCronJob } from "./lib";

void runCronJob("plan-limits");
