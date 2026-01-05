import { describe, expect, test } from "vitest";

import { serializeErrorEventForAdmin } from "@/lib/errors/serializeErrorEvent";

describe("errors/serializeErrorEvent", () => {
  test("strips sensitive keys from meta even if stored", () => {
    const doc = {
      _id: "507f1f77bcf86cd799439011",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      env: "production",
      severity: "error",
      category: "api",
      code: "UNHANDLED_EXCEPTION",
      message: "boom",
      meta: {
        authorization: "Bearer abc",
        cookie: "sid=abc",
        token: "tok_123",
        nested: { client_secret: "cs_123", ok: true },
      },
    };

    const out = serializeErrorEventForAdmin(doc) as any;
    expect(out.meta).toBeTruthy();
    expect(out.meta.authorization).toBeUndefined();
    expect(out.meta.cookie).toBeUndefined();
    expect(out.meta.token).toBeUndefined();
    expect(out.meta.nested?.client_secret).toBeUndefined();
    expect(out.meta.nested?.ok).toBe(true);
  });
});


