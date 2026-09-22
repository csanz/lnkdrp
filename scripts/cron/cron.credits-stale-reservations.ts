// cron.credits-stale-reservations — runs the `/api/cron/credits-stale-reservations` job. Vercel schedule: 25 * * * *
// Usage: npm run cron:credits-stale-reservations -- [--limit=N] [--olderThanMs=N] [--dry-run] [--target=https://lnkdrp.com]
import { runCronJob } from "./lib";

void runCronJob("credits-stale-reservations");
