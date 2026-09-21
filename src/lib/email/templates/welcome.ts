/**
 * The first email a new account gets, sent once when the account is created.
 *
 * Deliberately not the same email as `waitlistApproved`, though they arrive at the same moment in a
 * person's life with the product. That one is a door opening for somebody standing outside it, so it
 * leads with the link and assumes they have been waiting. This one is read by somebody who is
 * *already signed in* — they came straight from Google and the app is open in the next tab. Leading
 * with "sign in here" would be telling them to do the thing they just did.
 *
 * So it does the job a welcome email can actually do that the product cannot: it is the thing in
 * their inbox two weeks later when they want to find this again, and it answers the question the
 * empty dashboard does not — what the free plan includes, so nobody goes hunting for a credit card
 * before their first upload.
 *
 * It does not claim to be the only email we will ever send: `plan_limit` and `member_removed` are
 * both account-level mail, and a welcome that promises otherwise is a lie with a delayed fuse.
 *
 * Only ever sent to accounts that are **not** waitlisted. A queued signup gets the waitlist page and,
 * later, `waitlistApproved` — sending "here's how to start" to somebody who cannot start yet is the
 * one thing this email must never do. The caller in `src/lib/auth.ts` makes that decision.
 */
import type { EmailContent } from "./downloadRequest";
import { emailBody } from "./signature";
import { getPublicSiteBase } from "@/lib/urls";
import { FREE_DOCUMENTS } from "@/lib/billing/planLimits";
import { FREE_STARTER_CREDITS } from "@/lib/credits/grants";

export function welcomeEmail(params: {
  /** Their first name, when Google gave us one. */
  name?: string | null;
  /** Overrides the configured site URL, for tests and callers that already resolved it. */
  appUrl?: string | null;
}): EmailContent {
  const first = (params.name ?? "").trim().split(/\s+/)[0] ?? "";
  const base = (params.appUrl ?? getPublicSiteBase() ?? "").trim().replace(/\/+$/, "");

  return {
    subject: "Welcome to LinkDrop",
    text: emailBody([
      first ? `Welcome, ${first}.` : "Welcome.",
      "",
      "Your account is ready. Upload a PDF, send the link instead of the file, and you'll see who opened it, which pages they actually read, and how long they spent on each one.",
      "",
      `You're on the free plan: ${FREE_DOCUMENTS} shared documents, as many links as you like on each — one per recipient, each with its own analytics — and ${FREE_STARTER_CREDITS} credits for the AI summaries and compares. No card needed.`,
      base ? "" : null,
      base ? `Your dashboard: ${base}/dashboard` : null,
      "",
      "Notifications about your documents — who opened what, download requests — are yours to set: immediately, once a day, or not at all, from your notification settings.",
    ]),
  };
}
