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

describe("the queue is off unless it is turned on", () => {
  test("an unset flag means off, and off means everyone walks in", () => {
    expect(waitlistEnabled()).toBe(false);
    expect(initialAccessStatus("someone@example.com")).toBe("approved");
  });

  test("the words that turn it on, and the ones that do not", () => {
    for (const on of ["1", "true", "TRUE", "on", "yes"]) {
      process.env.WAITLIST_ENABLED = on;
      expect(waitlistEnabled(), on).toBe(true);
    }
    for (const off of ["0", "false", "off", "no", "", " "]) {
      process.env.WAITLIST_ENABLED = off;
      expect(waitlistEnabled(), JSON.stringify(off)).toBe(false);
    }
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
