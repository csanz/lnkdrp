// cron.account-purge — runs the `/api/cron/account-purge` job. Vercel schedule: 30 4 * * *
// Usage: npm run cron:account-purge -- [--dry-run] [--limit=N] [--target=https://lnkdrp.com]
import { runCronJob } from "./lib";

void runCronJob("account-purge");
