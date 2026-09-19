import { describe, expect, test } from "vitest";

import {
  VERIFY_EMAIL_MAX_PER_ADDRESS,
  VERIFY_EMAIL_MIN_INTERVAL_MS,
  ownerNeedsIntroductionEmail,
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

/**
 * The owner's mail is a correction, not an announcement: it exists only for the case where the
 * anonymous "someone opened your document" email already went out and is now wrong.
 */
describe("whether the owner needs telling", () => {
  const OLD_CURSOR = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);

  test("not when the introduction arrives before any notification has run", () => {
    expect(
      ownerNeedsIntroductionEmail({ viewerFirstSeenAt: NOW, notifiedThroughAt: null, cursorCreatedAt: null }),
    ).toBe(false);
  });

  test("not when the reader appeared after the last notification went out", () => {
    // The pending mail has not been sent yet, so it will carry their name by itself.
    expect(
      ownerNeedsIntroductionEmail({
        viewerFirstSeenAt: NOW,
        notifiedThroughAt: new Date(NOW.getTime() - 60 * 1000),
        cursorCreatedAt: OLD_CURSOR,
      }),
    ).toBe(false);
  });

  test("yes when the anonymous mail already covered this reader", () => {
    expect(
      ownerNeedsIntroductionEmail({
        viewerFirstSeenAt: new Date(NOW.getTime() - 60 * 60 * 1000),
        notifiedThroughAt: NOW,
        cursorCreatedAt: OLD_CURSOR,
      }),
    ).toBe(true);
  });

  test("a cursor exactly on the first view counts as covered", () => {
    // The notification run selects events at or after the cursor, so equality means it was in one.
    expect(
      ownerNeedsIntroductionEmail({ viewerFirstSeenAt: NOW, notifiedThroughAt: NOW, cursorCreatedAt: OLD_CURSOR }),
    ).toBe(true);
  });

  test("nothing to correct when we never saw the reader arrive", () => {
    expect(
      ownerNeedsIntroductionEmail({ viewerFirstSeenAt: null, notifiedThroughAt: NOW, cursorCreatedAt: OLD_CURSOR }),
    ).toBe(false);
  });

  /**
   * The case that actually exists in this database today: the notification job has never run, so
   * nobody has a cursor. Its first run stamps every cursor at `now` and sends nothing — there is no
   * backfill — which leaves a cursor sitting far in advance of readings it never looked at.
   */
  test("a cursor created after the reader arrived proves nothing, however far it has advanced", () => {
    const readerArrived = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    expect(
      ownerNeedsIntroductionEmail({
        viewerFirstSeenAt: readerArrived,
        // Initialised an hour ago at "now", covering nothing before it.
        notifiedThroughAt: new Date(NOW.getTime() - 60 * 60 * 1000),
        cursorCreatedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      }),
    ).toBe(false);
  });

  test("an unknown cursor age is never treated as proof", () => {
    expect(
      ownerNeedsIntroductionEmail({
        viewerFirstSeenAt: new Date(NOW.getTime() - 60 * 60 * 1000),
        notifiedThroughAt: NOW,
        cursorCreatedAt: null,
      }),
    ).toBe(false);
  });
});
