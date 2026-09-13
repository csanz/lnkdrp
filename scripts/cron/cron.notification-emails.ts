// cron.notification-emails — runs the `/api/cron/notification-emails` job. Vercel schedule: */5 * * * *
// Usage: npm run cron:notification-emails -- [--dry-run] [--limit=N] [--target=https://lnkdrp.com]
import { runCronJob } from "./lib";

void runCronJob("notification-emails");
