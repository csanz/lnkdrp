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
 * - Exits when the run ends: the Mongo connection is closed in `runNotificationEmailsCli`.
 */
import mongoose from "mongoose";
import { sendNotificationEmails } from "@/lib/notifications/sendNotificationEmails";
import { runNotificationEmailsCli } from "@/lib/notifications/sendNotificationEmailsCli";

void runNotificationEmailsCli(process.argv.slice(2), {
  send: sendNotificationEmails,
  disconnect: () => mongoose.disconnect(),
  // eslint-disable-next-line no-console
  log: (line) => console.log(line),
  // eslint-disable-next-line no-console
  logError: (err) => console.error(err),
}).then((code) => {
  process.exitCode = code;
});
