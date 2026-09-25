/** The share-auth cookie compare: constant time, and strict about empties (review Low, public share). */
import { describe, expect, it } from "vitest";

import { shareAuthCookieMatches } from "../../src/lib/share/cookieCompare";

const DIGEST = "a".repeat(64);

describe("shareAuthCookieMatches", () => {
  it("accepts the exact digest and nothing else", () => {
    expect(shareAuthCookieMatches(DIGEST, DIGEST)).toBe(true);
    expect(shareAuthCookieMatches(DIGEST.slice(0, 63) + "b", DIGEST)).toBe(false);
    expect(shareAuthCookieMatches(DIGEST + "a", DIGEST)).toBe(false);
    expect(shareAuthCookieMatches(DIGEST.slice(1), DIGEST)).toBe(false);
  });

  it("refuses a missing cookie, and never matches an empty expectation", () => {
    expect(shareAuthCookieMatches(null, DIGEST)).toBe(false);
    expect(shareAuthCookieMatches(undefined, DIGEST)).toBe(false);
    expect(shareAuthCookieMatches("", DIGEST)).toBe(false);
    expect(shareAuthCookieMatches("", "")).toBe(false);
  });

  it("does not throw on a length mismatch (timingSafeEqual would)", () => {
    expect(() => shareAuthCookieMatches("short", DIGEST)).not.toThrow();
  });
});
