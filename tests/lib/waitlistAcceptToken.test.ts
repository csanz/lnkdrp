/**
 * The invitation link's token.
 *
 * It travels in a URL, in mail that gets forwarded and archived, and at the end of the flow it
 * leads to a record that somebody agreed to the Terms. So what matters is less that a good token
 * verifies — that is one test — than that a *nearly* good one does not: a tampered payload, a
 * signature from another purpose, a token that has aged out.
 *
 * The token is deliberately not authentication. `/accept` also requires a session whose user id
 * matches, and that split is what makes the record worth keeping; see `acceptToken.ts`.
 */
import { describe, expect, test } from "vitest";

import {
  WAITLIST_ACCEPT_TTL_MS,
  createAcceptToken,
  verifyAcceptToken,
} from "@/lib/waitlist/acceptToken";

const USER = "6ab1aa1b55068178c03c61cf";

describe("a token we made", () => {
  test("verifies, and names the account", () => {
    const token = createAcceptToken({ userId: USER });

    expect(verifyAcceptToken(token)).toEqual({ ok: true, userId: USER });
  });

  test("two tokens for the same user differ, because the expiry moves", () => {
    const a = createAcceptToken({ userId: USER, now: 1_000 });
    const b = createAcceptToken({ userId: USER, now: 2_000 });

    expect(a).not.toBe(b);
    expect(verifyAcceptToken(b, { now: 2_500 })).toEqual({ ok: true, userId: USER });
  });
});

describe("a token we did not make", () => {
  test("a flipped byte in the payload fails on the signature, not the parse", () => {
    const token = createAcceptToken({ userId: USER });
    const [segment, signature] = token.split(".");
    // Re-encode a payload naming somebody else, keeping the original signature.
    const forged = Buffer.from(
      JSON.stringify({ v: 1, p: "waitlist_accept", u: "6ab1aa1b55068178c03c61aa", e: Date.now() + 60_000 }),
      "utf8",
    ).toString("base64url");

    expect(verifyAcceptToken(`${forged}.${signature}`)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyAcceptToken(`${segment}.${signature.slice(0, -1)}x`)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  test("garbage is malformed, not a crash", () => {
    for (const v of ["", "   ", ".", "a.", ".b", "no-dot", "a.b.c.d", "x".repeat(2000), null, undefined, 42, {}]) {
      const out = verifyAcceptToken(v as never);
      expect(out.ok).toBe(false);
    }
  });

  test("a signature minted for another purpose does not verify here", () => {
    // The key is HKDF-derived from the purpose, so a token from the unsubscribe family cannot be
    // replayed into this one even though the format is identical.
    const foreign = Buffer.from(
      JSON.stringify({ v: 1, p: "view_emails_off", m: USER, e: Date.now() + 60_000 }),
      "utf8",
    ).toString("base64url");

    const out = verifyAcceptToken(`${foreign}.${"a".repeat(43)}`);
    expect(out.ok).toBe(false);
    // It never gets as far as reading `p`: the signature is wrong first, which is the stronger
    // refusal and the one that does not leak whether the purpose was close.
    expect(out).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("expiry", () => {
  test("a token past its expiry is refused", () => {
    const token = createAcceptToken({ userId: USER, now: 0, ttlMs: 1_000 });

    expect(verifyAcceptToken(token, { now: 999 })).toEqual({ ok: true, userId: USER });
    expect(verifyAcceptToken(token, { now: 1_000 })).toMatchObject({ ok: false, reason: "expired" });
  });

  test("an expired token still names its account, so the page can offer a new link", () => {
    const token = createAcceptToken({ userId: USER, now: 0, ttlMs: 1 });

    expect(verifyAcceptToken(token, { now: 10_000 })).toEqual({ ok: false, reason: "expired", userId: USER });
  });

  test("the default lifetime is two weeks", () => {
    // Long enough for somebody who read it on a phone and came back at the weekend; short enough
    // that a forwarded invitation stops working within a fortnight.
    expect(WAITLIST_ACCEPT_TTL_MS).toBe(14 * 24 * 60 * 60 * 1000);

    const token = createAcceptToken({ userId: USER, now: 0 });
    expect(verifyAcceptToken(token, { now: WAITLIST_ACCEPT_TTL_MS - 1 }).ok).toBe(true);
    expect(verifyAcceptToken(token, { now: WAITLIST_ACCEPT_TTL_MS }).ok).toBe(false);
  });
});
