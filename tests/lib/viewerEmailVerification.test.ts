import { describe, expect, test } from "vitest";

import {
  VERIFY_EMAIL_MAX_PER_ADDRESS,
  VERIFY_EMAIL_MIN_INTERVAL_MS,
  shouldSendVerifyEmail,
} from "@/lib/share/viewerEmailVerification";

/**
 * The two rules that decide whether anyone gets an email when a reader introduces themselves.
 * Both are pure so they can be pinned here rather than inferred from a route, and both exist to
 * stop us mailing people who did not ask to hear from us.
 */
const NOW = new Date("2026-09-19T12:00:00.000Z");

describe("confirmation mail bounds", () => {
  test("a first introduction is mailed", () => {
    expect(
      shouldSendVerifyEmail({ verified: false, verifyEmailsSent: 0, lastVerifyEmailAt: null }, NOW),
    ).toBe(true);
  });

  test("an address that already confirmed is never mailed again", () => {
    expect(
      shouldSendVerifyEmail({ verified: true, verifyEmailsSent: 0, lastVerifyEmailAt: null }, NOW),
    ).toBe(false);
  });

  test("a burst is collapsed by the interval", () => {
    const justNow = new Date(NOW.getTime() - 60 * 1000);
    expect(shouldSendVerifyEmail({ verified: false, verifyEmailsSent: 1, lastVerifyEmailAt: justNow }, NOW)).toBe(false);

    const longAgo = new Date(NOW.getTime() - VERIFY_EMAIL_MIN_INTERVAL_MS - 1000);
    expect(shouldSendVerifyEmail({ verified: false, verifyEmailsSent: 1, lastVerifyEmailAt: longAgo }, NOW)).toBe(true);
  });

  test("a slow drip stops at the cap, however long the gaps", () => {
    const ages = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
    expect(
      shouldSendVerifyEmail(
        { verified: false, verifyEmailsSent: VERIFY_EMAIL_MAX_PER_ADDRESS, lastVerifyEmailAt: ages },
        NOW,
      ),
    ).toBe(false);
  });
});
