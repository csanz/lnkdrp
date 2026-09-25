/**
 * The debug routes are admin-gated everywhere, not only in production (code review 2026-09-23,
 * Admin / cron). Production hides them from non-admins as 404; elsewhere the gate's own status.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn() }));

vi.mock("@/lib/gating/requireAdmin", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/http/errorResponse", () => ({ errorJson: () => new Response("err", { status: 500 }) }));
vi.mock("@/lib/debug", () => ({ debugEnabled: () => false }));

import { GET as debugGet } from "@/app/api/debug/route";
import { GET as cookieGet } from "@/app/api/debug/cookie/route";

const req = () => new Request("http://localhost:3001/api/debug", { headers: { cookie: "a=b" } });

describe("debug routes", () => {
  const env = process.env.NODE_ENV;
  beforeEach(() => mocks.requireAdmin.mockReset());
  afterEach(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = env;
  });

  it("answer 404 to a non-admin in production", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    mocks.requireAdmin.mockResolvedValue({ ok: false, status: 401, error: "Unauthorized" });
    expect((await debugGet(req())).status).toBe(404);
    expect((await cookieGet(req())).status).toBe(404);
  });

  it("answer the gate's status to a non-admin outside production", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    mocks.requireAdmin.mockResolvedValue({ ok: false, status: 403, error: "Forbidden" });
    expect((await debugGet(req())).status).toBe(403);
    expect((await cookieGet(req())).status).toBe(403);
  });

  it("answer an admin", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    mocks.requireAdmin.mockResolvedValue({ ok: true, userId: "u", email: "a@b.test" });
    const res = await debugGet(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { env?: { has_MONGODB_URI?: boolean } };
    expect(body.env).toHaveProperty("has_MONGODB_URI");
    const cookie = await cookieGet(req());
    expect(cookie.status).toBe(200);
    expect(((await cookie.json()) as { cookie?: string }).cookie).toBe("a=b");
  });
});
