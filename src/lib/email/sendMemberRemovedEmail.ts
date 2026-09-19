/**
 * Email helper: tells someone their access to a workspace was removed.
 *
 * Losing access is something a person finds out about either from us or from a page that suddenly
 * shows nothing, so it is worth an email. The copy answers what they will actually wonder: their
 * account is untouched, their own workspace is still theirs, and the documents they uploaded stay
 * with the workspace rather than leaving with them.
 *
 * Best-effort by design: the caller must never fail a removal because an email did not send —
 * the access change is the security action, the notice is a courtesy.
 */
import { sendTextEmail } from "@/lib/email/sendTextEmail";

type SendMemberRemovedEmailParams = {
  to: string;
  orgName: string;
  /** Who removed them, when we know it; owners and admins are visible to members anyway. */
  removedByEmail?: string | null;
  /** The app's base URL, for the link back to their own workspace. */
  appUrl?: string | null;
};

export async function sendMemberRemovedEmail(params: SendMemberRemovedEmailParams): Promise<void> {
  const { to, orgName, removedByEmail } = params;
  const appUrl = (params.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/+$/, "");
  const workspace = orgName.trim() || "a workspace";

  const text = [
    `You no longer have access to the workspace "${workspace}".`,
    "",
    removedByEmail ? `Removed by: ${removedByEmail}` : null,
    "",
    "What this means:",
    `- You can no longer open that workspace's documents, links or metrics.`,
    `- Anything you uploaded stays with the workspace, and its share links keep working for recipients.`,
    `- Your own account and personal workspace are unchanged.`,
    "",
    "If you think this was a mistake, ask an owner or admin of that workspace to invite you back.",
    appUrl ? "" : null,
    appUrl ? `Your workspace: ${appUrl}` : null,
    "",
    "- LinkDrop",
  ]
    .filter((line) => line !== null)
    .join("\n");

  await sendTextEmail({
    to,
    subject: `You were removed from ${workspace}`,
    text,
  });
}
