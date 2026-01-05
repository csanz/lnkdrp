import { describe, expect, test } from "vitest";

import { sanitizeMeta } from "@/lib/errors/logger";

describe("errors/logger sanitizeMeta", () => {
  test("removes sensitive keys and redacts jwt-like strings", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTYifQ.sgnaturepart";
    const input = {
      authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
      cookie: "sid=abc",
      token: "tok_123",
      password: "pw",
      secret: "shh",
      client_secret: "cs_123",
      stripeSignature: "t=123,v1=abc",
      nested: {
        Authorization: "Bearer should_be_removed_by_key",
        ok: "keep",
        jwt,
      },
      arr: [{ setCookie: "a=b" }, jwt],
    };

    const out = sanitizeMeta(input) as any;

    expect(out).toBeTruthy();
    expect(out.authorization).toBeUndefined();
    expect(out.cookie).toBeUndefined();
    expect(out.token).toBeUndefined();
    expect(out.password).toBeUndefined();
    expect(out.secret).toBeUndefined();
    expect(out.client_secret).toBeUndefined();
    expect(out.stripeSignature).toBeUndefined();

    expect(out.nested).toBeTruthy();
    expect(out.nested.Authorization).toBeUndefined();
    expect(out.nested.ok).toBe("keep");
    expect(out.nested.jwt).toBe("[REDACTED_JWT]");

    expect(Array.isArray(out.arr)).toBe(true);
    expect(out.arr[0]?.setCookie).toBeUndefined();
    expect(out.arr[1]).toBe("[REDACTED_JWT]");
  });
});


