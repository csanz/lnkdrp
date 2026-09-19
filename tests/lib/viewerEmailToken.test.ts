import { describe, expect, test } from "vitest";

import {
  createViewerEmailToken,
  verifyViewerEmailToken,
  viewerEmailVerifyUrl,
  VIEWER_EMAIL_TOKEN_TTL_MS,
} from "@/lib/share/viewerEmailToken";

const payload = { shareId: "gAlCd3rWDLkO", viewerKey: "abc123", email: "sam@example.com" };

describe("viewer email verification token", () => {
  test("round-trips what was signed", () => {
    const res = verifyViewerEmailToken(createViewerEmailToken(payload));
    expect(res).toEqual({ ok: true, ...payload });
  });

  test("expires", () => {
    const now = new Date("2026-09-18T00:00:00.000Z");
    const token = createViewerEmailToken(payload, { now });
    expect(verifyViewerEmailToken(token, { now: new Date(now.getTime() + VIEWER_EMAIL_TOKEN_TTL_MS - 1000) }).ok).toBe(true);
    expect(verifyViewerEmailToken(token, { now: new Date(now.getTime() + VIEWER_EMAIL_TOKEN_TTL_MS) })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  test("a tampered payload does not verify", () => {
    const token = createViewerEmailToken(payload);
    const [body, sig] = token.split(".") as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString("utf8")), m: "attacker@example.com" }),
      "utf8",
    ).toString("base64url");
    expect(verifyViewerEmailToken(`${forged}.${sig}`)).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("rubbish is malformed, never a throw", () => {
    for (const t of ["", "x", "a.b.c", "!!!.???", "x".repeat(5000)]) {
      expect(verifyViewerEmailToken(t).ok).toBe(false);
    }
  });

  test("the URL carries the token and nothing else", () => {
    const url = new URL(viewerEmailVerifyUrl("http://localhost:3001/", payload));
    expect(url.pathname).toBe("/share/verify");
    const t = url.searchParams.get("t") ?? "";
    expect(verifyViewerEmailToken(t)).toEqual({ ok: true, ...payload });
  });
});
