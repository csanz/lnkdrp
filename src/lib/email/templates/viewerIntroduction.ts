/**
 * The two emails around a reader introducing themselves on a share link.
 *
 * The reader's mail is a confirmation, not a gate (owner, 2026-09-18): they are already reading the
 * document and the copy says so, because an email that looks like a wall in front of something
 * already open reads as spam. What it buys them is that their name reaches the sender instead of
 * "Someone".
 *
 * The owner's mail covers the one case the view notifications cannot: "someone opened your
 * document" already went out anonymously, and the reader said who they were afterwards. Without it
 * that first email stays wrong in the inbox forever and the correction lives only in the feed.
 */
import type { EmailContent } from "./downloadRequest";
import { emailBody } from "./signature";

/** To the reader: one click to confirm the address they typed. Nothing waits on it. */
export function viewerVerifyEmail(params: {
  /** What they are reading, for a subject they recognise. */
  documentTitle?: string | null;
  /** Who shared it, when the workspace has a name worth showing. */
  workspaceName?: string | null;
  verifyUrl: string;
}): EmailContent {
  const title = (params.documentTitle ?? "").trim();
  const workspace = (params.workspaceName ?? "").trim();
  const what = title ? `"${title}"` : "a document";

  return {
    subject: title ? `Confirm your email for "${title}"` : "Confirm your email",
    text: emailBody([
      `You introduced yourself while reading ${what}${workspace ? ` from ${workspace}` : ""}.`,
      "",
      "Confirm this is your address so the sender sees your name rather than an anonymous reader:",
      params.verifyUrl,
      "",
      "You do not have to. The document stays open either way, and this link simply expires in a day.",
    ]),
  };
}

/** To the owner: who the anonymous reader turned out to be, and whether to believe it. */
export function viewerIntroducedEmail(params: {
  documentTitle?: string | null;
  viewerName?: string | null;
  viewerEmail: string;
  verified: boolean;
  /** Where the owner goes to see the reading itself. */
  metricsUrl?: string | null;
}): EmailContent {
  const title = (params.documentTitle ?? "").trim();
  const what = title ? `"${title}"` : "your document";
  const name = (params.viewerName ?? "").trim();
  const who = name ? `${name} (${params.viewerEmail})` : params.viewerEmail;

  return {
    subject: name ? `${name} introduced themselves on ${what}` : `A reader introduced themselves on ${what}`,
    text: emailBody([
      `${who} says they are the reader who opened ${what}.`,
      "",
      params.verified
        ? "They confirmed the address by email, so it is theirs."
        : "They typed this address and have not confirmed it yet, so treat it as their claim rather than a fact.",
      params.metricsUrl ? "" : null,
      params.metricsUrl ? `What they read: ${params.metricsUrl}` : null,
    ]),
  };
}
