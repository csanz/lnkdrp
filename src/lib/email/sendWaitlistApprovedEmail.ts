/**
 * Email helper: tells someone their early-access account is open.
 *
 * Best-effort at the call site, like every other notice: approving someone must succeed even when
 * the mail does not, since the approval is the thing that lets them in and the email only tells
 * them so. The body lives in `templates/waitlistApproved.ts`.
 */
import { sendEmailContent } from "@/lib/email/sendTextEmail";
import { waitlistApprovedEmail } from "@/lib/email/templates";

export async function sendWaitlistApprovedEmail(params: {
  to: string;
  name?: string | null;
  appUrl?: string | null;
  /** A one-time `/accept` link; when present the mail asks them to accept rather than just start. */
  acceptUrl?: string | null;
}): Promise<void> {
  const content = waitlistApprovedEmail({
    name: params.name,
    appUrl: params.appUrl,
    acceptUrl: params.acceptUrl,
  });
  await sendEmailContent({ to: params.to, ...content });
}
