/**
 * "Your account is open" — the one email a queued person is actually waiting for.
 *
 * Sent when an admin approves them (`POST /api/admin/waitlist/:userId/approve`), once: the approve
 * call only sends when it is the call that changed the row, so clicking twice does not email twice.
 *
 * Short, and it leads with the link. Someone who has been waiting does not need the product
 * explained again — they need the door. What follows the link is only what they cannot guess: what
 * the free plan gives them, so nobody goes looking for a credit card first.
 */
import { blocks, transactional, type EmailContent } from "./compose";
import { getPublicSiteBase } from "@/lib/urls";
import { FREE_DOCUMENTS } from "@/lib/billing/planLimits";
import { FREE_STARTER_CREDITS } from "@/lib/credits/grants";

export function waitlistApprovedEmail(params: {
  /** Their first name, when we have one — "You're in, Dana" reads like a person wrote it. */
  name?: string | null;
  /** Overrides the configured site URL, for tests and callers that already resolved it. */
  appUrl?: string | null;
  /**
   * The one-time `/accept` link, when the invitation carries one.
   *
   * Optional because the admin Approve button still opens an account without asking for anything
   * back, and that path should keep sending the same short mail rather than a screen full of
   * agreement somebody has to click past. When it is present it *replaces* the plain link: two
   * buttons, one of which quietly skips the Terms, would make accepting them optional.
   */
  acceptUrl?: string | null;
}): EmailContent {
  const first = (params.name ?? "").trim().split(/\s+/)[0] ?? "";
  const base = (params.appUrl ?? getPublicSiteBase() ?? "").trim().replace(/\/+$/, "");
  const accept = (params.acceptUrl ?? "").trim();

  return transactional({
    subject: "You're in: your LinkDrop account is open",
    preheader: "Sign in with the same Google account you signed up with.",
    blocks: blocks(
      { kind: "heading", text: first ? `You're in, ${first}.` : "You're in." },
      {
        kind: "p",
        text: "Your LinkDrop account is open. Sign in with the same Google account you signed up with and upload something.",
      },
      accept
        ? { kind: "action", label: "Accept your invitation", url: accept }
        : base
          ? { kind: "action", label: "Start here", url: base }
          : null,
      accept
        ? {
            kind: "muted",
            text: "The link opens a page where you accept the Terms and get started. It works for two weeks, and only for the account this was sent to.",
          }
        : null,
      {
        kind: "p",
        text: `You're on the free plan: ${FREE_DOCUMENTS} shared documents with view and download tracking, as many links as you like on each, and ${FREE_STARTER_CREDITS} credits for the AI summaries and compares. No card needed.`,
      },
      { kind: "muted", text: "Thanks for waiting." },
    ),
  });
}
