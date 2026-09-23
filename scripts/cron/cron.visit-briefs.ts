// cron.visit-briefs — runs the `/api/cron/visit-briefs` job. Vercel schedule: */5 * * * *
// Usage: npm run cron:visit-briefs -- [--dry-run] [--limit=N] [--target=https://lnkdrp.com]
import { runCronJob } from "./lib";

void runCronJob("visit-briefs");
