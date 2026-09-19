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
 *
 * The body lives in `templates/memberRemoved.ts` with every other email we send, so it can be read
 * and tested without going through the revoke route.
 */
import { sendTextEmail } from "@/lib/email/sendTextEmail";
import { memberRemovedEmail } from "@/lib/email/templates";

type SendMemberRemovedEmailParams = {
  to: string;
  orgName: string;
  /** Who removed them, when we know it; owners and admins are visible to members anyway. */
  removedByEmail?: string | null;
  /** The app's base URL, for the link back to their own workspace. */
  appUrl?: string | null;
};

export async function sendMemberRemovedEmail(params: SendMemberRemovedEmailParams): Promise<void> {
  const { subject, text } = memberRemovedEmail({
    orgName: params.orgName,
    removedByEmail: params.removedByEmail,
    appUrl: params.appUrl,
  });
  await sendTextEmail({ to: params.to, subject, text });
}
