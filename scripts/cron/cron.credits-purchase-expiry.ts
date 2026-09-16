// cron.credits-purchase-expiry — runs the `/api/cron/credits-purchase-expiry` job. Vercel schedule: 5 4 * * *
// Usage: npm run cron:credits-purchase-expiry -- [--limit=N] [--target=https://lnkdrp.com]
import { runCronJob } from "./lib";

void runCronJob("credits-purchase-expiry");
