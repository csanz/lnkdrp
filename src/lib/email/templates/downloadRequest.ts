/**
 * Download requests: when a link has downloads off, a recipient can ask for the file.
 *
 * Three emails, in order: a receipt to whoever asked, the approve/deny mail to the owner, and the
 * approval mail with the claim link. `POST /api/share/[shareId]/download-requests` sends the first
 * two; the approve route sends the third.
 */
import type { Block } from "@/lib/email/layout";
import { blocks, transactional, type EmailContent } from "./compose";

/** Re-exported: `EmailContent` moved to `compose.ts`, where the renderer that produces it lives. */
export type { EmailContent };

const MISSING_URL = "(missing NEXT_PUBLIC_SITE_URL)";

/**
 * A link we have becomes a button; a link we do not becomes a visible complaint.
 *
 * The owner mail used to print `Approve: ` with nothing after it when `NEXT_PUBLIC_SITE_URL` was
 * unset, which reads as a broken email rather than a broken deployment. An `action` block with an
 * empty href would be the same bug wearing a button, so the fallback stays a labelled row.
 */
function linkBlock(label: string, url: string, variant?: "secondary"): Block {
  if (!url) return { kind: "rows", rows: [[label, MISSING_URL]] };
  return variant ? { kind: "action", label, url, variant } : { kind: "action", label, url };
}

/** Receipt to the person who asked, sent once per new request (not for repeats inside the window). */
export function downloadRequestReceivedEmail(params: { title: string; shareUrl: string }): EmailContent {
  const title = params.title || "Shared document";
  return transactional({
    subject: `Request received: ${title}`,
    preheader: "We passed your request to the owner.",
    blocks: blocks(
      { kind: "p", text: "We sent your request to the owner to allow downloading this PDF." },
      {
        kind: "rows",
        rows: params.shareUrl
          ? [["Document", title], ["Link", params.shareUrl]]
          : [["Document", title]],
      },
      {
        kind: "muted",
        text: "If approved, you\u2019ll receive another email with a link to download or save it to your LinkDrop account (sign-in required).",
      },
    ),
  });
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
  return transactional({
    subject: `Download request: ${title}`,
    preheader: `${params.requesterEmail} asked to download it.`,
    blocks: blocks(
      { kind: "p", text: "A receiver requested a PDF download." },
      {
        kind: "rows",
        rows: [
          ["Document", title],
          ...(params.shareUrl ? ([["Share link", params.shareUrl]] as Array<[string, string]>) : []),
          ["Requester email", params.requesterEmail],
        ],
      },
      linkBlock("Approve", params.approveUrl),
      linkBlock("Deny", params.denyUrl, "secondary"),
    ),
  });
}

/** Sent when the owner approves: the claim link, which needs a sign-in. */
export function downloadRequestApprovedEmail(params: { title: string; claimUrl: string }): EmailContent {
  const title = params.title || "Shared document";
  return transactional({
    subject: `Download approved: ${title}`,
    preheader: "Sign in to download or save it.",
    blocks: blocks(
      { kind: "p", text: "Your download request was approved." },
      { kind: "rows", rows: [["Document", title]] },
      linkBlock("Open to download or save", params.claimUrl),
      { kind: "muted", text: "You\u2019ll need to sign in to LinkDrop to continue." },
    ),
  });
}
