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
import type { EmailWorkspace } from "@/lib/email/layout";
import { blocks, transactional, type EmailContent } from "./compose";

/** To the reader: one click to confirm the address they typed. Nothing waits on it. */
export function viewerVerifyEmail(params: {
  /** What they are reading, for a subject they recognise. */
  documentTitle?: string | null;
  /** Who shared it, when the workspace has a name worth showing. */
  workspaceName?: string | null;
  verifyUrl: string;
  /** Carries the avatar when the caller resolved one; falls back to `workspaceName`. */
  workspace?: EmailWorkspace | null;
}): EmailContent {
  const title = (params.documentTitle ?? "").trim();
  const workspace = (params.workspaceName ?? "").trim();
  const what = title ? `"${title}"` : "a document";

  return transactional({
    subject: title ? `Confirm your email for "${title}"` : "Confirm your email",
    preheader: "Optional: the document stays open either way.",
    // The reader has never heard of LinkDrop; the name they recognise is whoever shared this.
    workspace: params.workspace ?? (workspace ? { name: workspace, avatarUrl: null } : null),
    blocks: blocks(
      { kind: "heading", text: "Confirm your email" },
      { kind: "p", text: `You introduced yourself while reading ${what}${workspace ? ` from ${workspace}` : ""}.` },
      {
        kind: "p",
        text: "Confirm this is your address so the sender sees your name rather than an anonymous reader:",
      },
      { kind: "action", label: "Confirm my email", url: params.verifyUrl },
      {
        kind: "muted",
        text: "You do not have to. The document stays open either way, and this link simply expires in a day.",
      },
    ),
  });
}

/** To the owner: who the anonymous reader turned out to be, and whether to believe it. */
export function viewerIntroducedEmail(params: {
  documentTitle?: string | null;
  viewerName?: string | null;
  viewerEmail: string;
  verified: boolean;
  /** Where the owner goes to see the reading itself. */
  metricsUrl?: string | null;
  /** Which workspace the reading happened in. */
  workspace?: EmailWorkspace | null;
}): EmailContent {
  const title = (params.documentTitle ?? "").trim();
  const what = title ? `"${title}"` : "your document";
  const name = (params.viewerName ?? "").trim();
  const who = name ? `${name} (${params.viewerEmail})` : params.viewerEmail;
  // The distinction the whole email exists to carry: a confirmed address is a fact, a typed one is
  // a claim. It stays in the body rather than becoming a badge, because a badge is easy to skim past.
  const standing = params.verified
    ? "They confirmed the address by email, so it is theirs."
    : "They typed this address and have not confirmed it yet, so treat it as their claim rather than a fact.";

  return transactional({
    subject: name ? `${name} introduced themselves on ${what}` : `A reader introduced themselves on ${what}`,
    preheader: params.verified ? "Confirmed by email." : "Unconfirmed: their claim, not a fact.",
    workspace: params.workspace ?? null,
    blocks: blocks(
      { kind: "heading", text: name ? `${name} introduced themselves` : "A reader introduced themselves" },
      { kind: "p", text: `${who} says they are the reader who opened ${what}.` },
      { kind: params.verified ? "p" : "muted", text: standing },
      params.metricsUrl ? { kind: "action", label: "What they read", url: params.metricsUrl } : null,
    ),
  });
}
