/**
 * The two emails around a reader introducing themselves on a share link.
 *
 * `sendViewerVerifyEmail` goes to the reader: one click to confirm the address they typed. It is
 * explicitly not a gate (owner, 2026-09-18) — they are already reading the document, and the copy
 * says so, because an email that looks like a wall in front of something already open reads as
 * spam. What it buys them is that their name reaches the sender instead of "Someone".
 *
 * `sendViewerIntroducedEmail` goes to the document's owner, and only in the case the notification
 * emails cannot cover: the "someone opened your document" mail already went out anonymously, and
 * the reader said who they were afterwards. Without it that first email stays wrong in the
 * owner's inbox forever, and the correction lives only in the activity feed.
 */
import { sendTextEmail } from "@/lib/email/sendTextEmail";

type SendViewerVerifyEmailParams = {
  to: string;
  /** What the reader is reading, for a subject they recognise. */
  documentTitle?: string | null;
  /** Who shared it, when the workspace has a name worth showing. */
  workspaceName?: string | null;
  verifyUrl: string;
};

export async function sendViewerVerifyEmail(params: SendViewerVerifyEmailParams): Promise<void> {
  const title = (params.documentTitle ?? "").trim();
  const workspace = (params.workspaceName ?? "").trim();
  const what = title ? `"${title}"` : "a document";

  const text = [
    `You introduced yourself while reading ${what}${workspace ? ` from ${workspace}` : ""}.`,
    "",
    "Confirm this is your address so the sender sees your name rather than an anonymous reader:",
    params.verifyUrl,
    "",
    "You do not have to. The document stays open either way, and this link simply expires in a day.",
    "",
    "- LinkDrop",
  ].join("\n");

  await sendTextEmail({
    to: params.to,
    subject: title ? `Confirm your email for "${title}"` : "Confirm your email",
    text,
  });
}

type SendViewerIntroducedEmailParams = {
  to: string;
  documentTitle?: string | null;
  viewerName?: string | null;
  viewerEmail: string;
  verified: boolean;
  /** Where the owner goes to see the reading itself. */
  metricsUrl?: string | null;
};

export async function sendViewerIntroducedEmail(params: SendViewerIntroducedEmailParams): Promise<void> {
  const title = (params.documentTitle ?? "").trim();
  const what = title ? `"${title}"` : "your document";
  const name = (params.viewerName ?? "").trim();
  const who = name ? `${name} (${params.viewerEmail})` : params.viewerEmail;

  const text = [
    `${who} says they are the reader who opened ${what}.`,
    "",
    params.verified
      ? "They confirmed the address by email, so it is theirs."
      : "They typed this address and have not confirmed it yet, so treat it as their claim rather than a fact.",
    "",
    params.metricsUrl ? `What they read: ${params.metricsUrl}` : null,
    params.metricsUrl ? "" : null,
    "- LinkDrop",
  ]
    .filter((line) => line !== null)
    .join("\n");

  await sendTextEmail({
    to: params.to,
    subject: name ? `${name} introduced themselves on ${what}` : `A reader introduced themselves on ${what}`,
    text,
  });
}
