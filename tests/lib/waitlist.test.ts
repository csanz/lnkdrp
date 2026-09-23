/**
 * Who the early-access queue applies to.
 *
 * The rules that matter are the ones about who it must *not* catch: a flag that gates sign-ups is
 * one bad default away from locking out the people already using the product, or from locking out
 * the admin who would have to undo it. The DB-backed parts (position, approval) are exercised
 * against the dev database instead; these are the pure decisions.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { accessStatusOf, initialAccessStatus, isAllowlistedEmail, waitlistEnabled } from "@/lib/waitlist/waitlist";

const ENV_KEYS = ["WAITLIST_ENABLED", "WAITLIST_ALLOW_EMAILS", "WAITLIST_ALLOW_DOMAINS"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("the queue is always on", () => {
  /**
   * This used to read `WAITLIST_ENABLED`, off unless set. The variable was not set in production
   * and the first person to sign in got a full account. Both failures are not equal: someone
   * waiting is approved a little later, while a stranger who already holds an account has been
   * inside the product and is undone only by deleting it. So the lock no longer depends on a
   * variable being present.
   */
  test("a new account is queued, whatever the environment says", () => {
    expect(waitlistEnabled()).toBe(true);
    expect(initialAccessStatus("someone@example.com")).toBe("waitlisted");
  });

  test("no value of the old flag opens the door", () => {
    for (const v of ["0", "false", "off", "no", "", " ", "1", "true"]) {
      process.env.WAITLIST_ENABLED = v;
      expect(waitlistEnabled(), JSON.stringify(v)).toBe(true);
      expect(initialAccessStatus("stranger@example.com"), JSON.stringify(v)).toBe("waitlisted");
    }
  });

  test("the ways through are all a person deciding", () => {
    // An operator naming the address, which is a decision typed out by hand.
    process.env.WAITLIST_ALLOW_EMAILS = "founder@lnkdrp.com";
    expect(initialAccessStatus("founder@lnkdrp.com")).toBe("approved");
    expect(initialAccessStatus("someone.else@lnkdrp.com")).toBe("waitlisted");
    delete process.env.WAITLIST_ALLOW_EMAILS;

    process.env.WAITLIST_ALLOW_DOMAINS = "lnkdrp.com";
    expect(initialAccessStatus("anyone@lnkdrp.com")).toBe("approved");
    expect(initialAccessStatus("anyone@gmail.com")).toBe("waitlisted");
    delete process.env.WAITLIST_ALLOW_DOMAINS;
  });
});

describe("who skips the queue", () => {
  beforeEach(() => {
    process.env.WAITLIST_ENABLED = "1";
  });

  test("a new sign-up queues while it is on", () => {
    expect(initialAccessStatus("stranger@example.com")).toBe("waitlisted");
  });

  test("an allowlisted address, by address or by domain", () => {
    process.env.WAITLIST_ALLOW_EMAILS = "founder@example.com, someone.else@example.org";
    process.env.WAITLIST_ALLOW_DOMAINS = "usavx.com";
    expect(isAllowlistedEmail("founder@example.com")).toBe(true);
    expect(isAllowlistedEmail("  FOUNDER@example.com  ")).toBe(true);
    expect(isAllowlistedEmail("anyone@usavx.com")).toBe(true);
    expect(isAllowlistedEmail("anyone@notusavx.com")).toBe(false);
    expect(initialAccessStatus("anyone@usavx.com")).toBe("approved");
  });

  test("a near-miss domain is not a match", () => {
    process.env.WAITLIST_ALLOW_DOMAINS = "usavx.com";
    // The check is on the domain itself, not on the address containing the string.
    expect(isAllowlistedEmail("usavx.com@example.com")).toBe(false);
    expect(isAllowlistedEmail("someone@sub.usavx.com")).toBe(false);
  });

  test("an empty or missing address is never allowlisted", () => {
    process.env.WAITLIST_ALLOW_EMAILS = "founder@example.com";
    expect(isAllowlistedEmail("")).toBe(false);
    expect(isAllowlistedEmail(null)).toBe(false);
    expect(isAllowlistedEmail(undefined)).toBe(false);
  });
});

describe("reading a user row's status", () => {
  test("a row with no status at all is approved — every account that predates the queue", () => {
    expect(accessStatusOf({})).toBe("approved");
    expect(accessStatusOf(null)).toBe("approved");
    expect(accessStatusOf(undefined)).toBe("approved");
  });

  test("only the exact string queues someone", () => {
    expect(accessStatusOf({ accessStatus: "waitlisted" })).toBe("waitlisted");
    expect(accessStatusOf({ accessStatus: "approved" })).toBe("approved");
    expect(accessStatusOf({ accessStatus: "pending" })).toBe("approved");
  });

  test("an admin is never held at the door, whatever the row says", () => {
    expect(accessStatusOf({ accessStatus: "waitlisted", role: "admin" })).toBe("approved");
  });
});
