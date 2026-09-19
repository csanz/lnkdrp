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
import type { EmailContent } from "./downloadRequest";
import { emailBody } from "./signature";
import { getPublicSiteBase } from "@/lib/urls";

export function waitlistApprovedEmail(params: {
  /** Their first name, when we have one — "You're in, Dana" reads like a person wrote it. */
  name?: string | null;
  /** Overrides the configured site URL, for tests and callers that already resolved it. */
  appUrl?: string | null;
}): EmailContent {
  const first = (params.name ?? "").trim().split(/\s+/)[0] ?? "";
  const base = (params.appUrl ?? getPublicSiteBase() ?? "").trim().replace(/\/+$/, "");

  return {
    subject: "You're in — your LinkDrop account is open",
    text: emailBody([
      first ? `You're in, ${first}.` : "You're in.",
      "",
      "Your LinkDrop account is open. Sign in with the same Google account you signed up with and upload something.",
      base ? "" : null,
      base ? `Start here: ${base}` : null,
      "",
      "You're on the free plan: three shared documents with view and download tracking, as many links as you like on each, and 50 credits for the AI summaries and compares. No card needed.",
      "",
      "Thanks for waiting.",
    ]),
  };
}
