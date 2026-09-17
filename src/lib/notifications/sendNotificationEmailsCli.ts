/**
 * Argument parsing and lifecycle for `scripts/notifications-send-emails.ts`.
 *
 * Kept out of the script so it is testable. The one rule that matters: the Mongo connection is
 * closed when the run ends, success or failure. `sendNotificationEmails` opens the cached mongoose
 * connection, whose sockets keep Node's event loop alive, so a CLI that only logs the result never
 * exits.
 */
import type { SendNotificationEmailsParams, SendNotificationEmailsResult } from "@/lib/notifications/sendNotificationEmails";

export type NotificationEmailsCliDeps = {
  send: (params: SendNotificationEmailsParams) => Promise<SendNotificationEmailsResult>;
  /** Closes every connection the run opened (e.g. `mongoose.disconnect`). */
  disconnect: () => Promise<unknown>;
  log: (line: string) => void;
  logError: (err: unknown) => void;
};

function argValue(argv: readonly string[], flag: string): string | null {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  const v = argv[idx + 1];
  return typeof v === "string" && !v.startsWith("--") ? v : null;
}

/** CLI flags -> runner params. Dry run unless `--send`. */
export function parseNotificationEmailsArgs(argv: readonly string[]): SendNotificationEmailsParams {
  return {
    dryRun: !argv.includes("--send"),
    forceDigest: argv.includes("--forceDigest"),
    workspaceId: argValue(argv, "--workspaceId"),
    userId: argValue(argv, "--userId"),
  };
}

/** Run once, print the JSON result, always disconnect. Resolves to the process exit code. */
export async function runNotificationEmailsCli(argv: readonly string[], deps: NotificationEmailsCliDeps): Promise<number> {
  let code = 0;
  try {
    const res = await deps.send(parseNotificationEmailsArgs(argv));
    deps.log(JSON.stringify(res, null, 2));
  } catch (err) {
    deps.logError(err);
    code = 1;
  } finally {
    try {
      await deps.disconnect();
    } catch (err) {
      deps.logError(err);
      code = code || 1;
    }
  }
  return code;
}
