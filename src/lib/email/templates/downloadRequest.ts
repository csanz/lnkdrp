/**
 * Download requests: when a link has downloads off, a recipient can ask for the file.
 *
 * Three emails, in order: a receipt to whoever asked, the approve/deny mail to the owner, and the
 * approval mail with the claim link. `POST /api/share/[shareId]/download-requests` sends the first
 * two; the approve route sends the third.
 */
import { emailBody } from "./signature";

export type EmailContent = { subject: string; text: string };

const MISSING_URL = "(missing NEXT_PUBLIC_SITE_URL)";

/** Receipt to the person who asked, sent once per new request (not for repeats inside the window). */
export function downloadRequestReceivedEmail(params: { title: string; shareUrl: string }): EmailContent {
  const title = params.title || "Shared document";
  return {
    subject: `Request received: ${title}`,
    text: emailBody([
      "We sent your request to the owner to allow downloading this PDF.",
      "",
      `Document: ${title}`,
      params.shareUrl ? `Link: ${params.shareUrl}` : null,
      "",
      "If approved, you’ll receive another email with a link to download or save it to your LinkDrop account (sign-in required).",
    ]),
  };
}

/** The owner's mail: who asked, for what, and the approve and deny links. */
export function downloadRequestOwnerEmail(params: {
  title: string;
  shareUrl: string;
  requesterEmail: string;
  approveUrl: string;
  denyUrl: string;
}): EmailContent {
  const title = params.title || "Shared document";
  return {
    subject: `Download request: ${title}`,
    text: emailBody([
      "A receiver requested a PDF download.",
      "",
      `Document: ${title}`,
      params.shareUrl ? `Share link: ${params.shareUrl}` : null,
      "",
      `Requester email: ${params.requesterEmail}`,
      "",
      `Approve: ${params.approveUrl || MISSING_URL}`,
      `Deny: ${params.denyUrl || MISSING_URL}`,
    ]),
  };
}

/** Sent when the owner approves: the claim link, which needs a sign-in. */
export function downloadRequestApprovedEmail(params: { title: string; claimUrl: string }): EmailContent {
  const title = params.title || "Shared document";
  return {
    subject: `Download approved: ${title}`,
    text: emailBody([
      "Your download request was approved.",
      "",
      `Document: ${title}`,
      "",
      `Open to download or save: ${params.claimUrl || MISSING_URL}`,
      "",
      "You’ll need to sign in to LinkDrop to continue.",
    ]),
  };
}
