/**
 * Local runner: send (or dry-run) notification emails.
 *
 * Usage:
 * - Dry run (default):   tsx scripts/notifications-send-emails.ts
 * - Actually send:       tsx scripts/notifications-send-emails.ts --send
 *
 * Optional filters:
 * - --workspaceId <id>
 * - --userId <id>
 * - --forceDigest
 *
 * Notes:
 * - For safe local testing without sending emails, you can also set `EMAIL_TRANSPORT=console`.
 * - Requires Mongo config (`MONGODB_URI`), same as running the app.
 */
import { sendNotificationEmails } from "@/lib/notifications/sendNotificationEmails";

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  const v = process.argv[idx + 1];
  return typeof v === "string" ? v : null;
}

async function main() {
  const send = process.argv.includes("--send");
  const dryRun = !send;
  const workspaceId = argValue("--workspaceId");
  const userId = argValue("--userId");
  const forceDigest = process.argv.includes("--forceDigest");

  const res = await sendNotificationEmails({
    dryRun,
    forceDigest,
    workspaceId,
    userId,
  });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(res, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});

