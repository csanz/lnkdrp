/**
 * Email helper: tells someone their early-access account is open.
 *
 * Best-effort at the call site, like every other notice: approving someone must succeed even when
 * the mail does not, since the approval is the thing that lets them in and the email only tells
 * them so. The body lives in `templates/waitlistApproved.ts`.
 */
import { sendTextEmail } from "@/lib/email/sendTextEmail";
import { waitlistApprovedEmail } from "@/lib/email/templates";

export async function sendWaitlistApprovedEmail(params: {
  to: string;
  name?: string | null;
  appUrl?: string | null;
}): Promise<void> {
  const { subject, text } = waitlistApprovedEmail({ name: params.name, appUrl: params.appUrl });
  await sendTextEmail({ to: params.to, subject, text });
}
