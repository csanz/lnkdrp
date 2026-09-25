/**
 * `ErrorEvent.stack` is redacted like `message` (code review 2026-09-23, M19), and `errorJson`
 * records an ErrorEvent for every unhandled exception, whatever status the route chose (M18).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(async () => undefined),
  connectMongo: vi.fn(async () => undefined),
}));

vi.mock("@/lib/mongodb", () => ({ connectMongo: mocks.connectMongo }));
vi.mock("@/lib/models/ErrorEvent", () => ({ ErrorEventModel: { create: mocks.create } }));
vi.mock("@/lib/debug", () => ({ debugLog: () => undefined, debugError: () => undefined, debugEnabled: () => false }));

import { logErrorEvent, redactSecretsInText, redactStack } from "@/lib/errors/logger";
import { serializeErrorEventForAdmin } from "@/lib/errors/serializeErrorEvent";
import { errorJson } from "@/lib/http/errorResponse";

const saved = { ...process.env };

describe("stack redaction", () => {
  beforeEach(() => {
    process.env.ERROR_LOGGING_ENABLED = "true";
    process.env.ERROR_LOGGING_MIN_SEVERITY = "error";
    // vitest runs with NODE_ENV=test, which is allowed nowhere by default.
    process.env.ERROR_LOGGING_ALLOWED_ENVS = "test,development";
    delete process.env.VERCEL_ENV;
    mocks.create.mockClear();
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("redactSecretsInText strips secrets but keeps line breaks", () => {
    const out = redactSecretsInText("Error: dup key ann@example.com\n    at foo (mongodb://u:p4ss@host/db)\n    at bar");
    expect(out).not.toMatch(/ann@example\.com|p4ss/);
    expect(out.split("\n")).toHaveLength(3);
    expect(redactStack(null)).toBeNull();
  });

  it("an error whose message carries an email is stored with a stack that does not", async () => {
    const err = new Error("E11000 dup key { email: \"ann@example.com\" }");
    await logErrorEvent({ severity: "error", category: "api", code: "UNHANDLED_EXCEPTION", err, route: "[test]" });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    const row = (mocks.create.mock.calls as unknown[][])[0][0] as { message: string; stack: string | null };
    expect(row.message).not.toContain("ann@example.com");
    expect(row.stack).toBeTruthy();
    expect(row.stack).not.toContain("ann@example.com");
    expect(row.stack).toContain("[REDACTED_EMAIL]");
  });

  it("the admin serializer redacts a stack stored before stacks were redacted", () => {
    const out = serializeErrorEventForAdmin({ _id: "x", stack: "Error: token for bob@example.com\n    at f" });
    expect(out.stack).not.toContain("bob@example.com");
    expect(out.stack).toContain("\n");
  });

  it("errorJson records an ErrorEvent for a caught exception even at a non-500 status", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = errorJson(new Error("mongo down"), { status: 400, publicMessage: "Could not load", context: "[test] failed" });
    expect(res.status).toBe(400);
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.create).toHaveBeenCalledTimes(1);
    const row = (mocks.create.mock.calls as unknown[][])[0][0] as { code: string; statusCode: number };
    expect(row.code).toBe("UNHANDLED_EXCEPTION");
    expect(row.statusCode).toBe(400);
    errSpy.mockRestore();
  });
});
