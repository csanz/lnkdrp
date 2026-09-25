/**
 * `POST /api/funnel` (docs/reviews/pricing-upsell-fix-plan-2026-09-23.md, Phase 4.1).
 *
 * The route is the browser's only way to write a funnel row, so what is pinned is the contract:
 * anonymous and API-key callers are refused, a bad body is a 400 that writes nothing, and a good
 * one becomes exactly one `funnel.*` activity row with `{ reason, cta, from }` in `meta`.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveActor: vi.fn(),
  rateLimit: vi.fn(async () => ({ ok: true, remaining: 59, retryAfterSec: 0 })),
  recordActivity: vi.fn(async () => undefined),
}));

vi.mock("@/lib/gating/actor", () => ({ resolveActor: mocks.resolveActor }));
vi.mock("@/lib/http/rateLimit", () => ({
  rateLimit: mocks.rateLimit,
  rateLimitedResponse: () => new Response(JSON.stringify({ error: "rate" }), { status: 429 }),
}));
vi.mock("@/lib/activity/log", () => ({ recordActivity: mocks.recordActivity }));

import { parseFunnelBody, POST } from "@/app/api/funnel/route";

const ORG_ID = "66f0a2b3c4d5e6f7a8b9c0d1";
const USER_ID = "66f0a2b3c4d5e6f7a8b9c0d2";
const USER = { kind: "user", userId: USER_ID, orgId: ORG_ID, personalOrgId: ORG_ID };

function post(body: unknown): Request {
  return new Request("http://localhost/api/funnel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("parseFunnelBody", () => {
  test("accepts the three events and the five ctas", () => {
    expect(parseFunnelBody({ event: "modal_shown", reason: "documents", from: "doc.x" })).toEqual({
      event: "modal_shown",
      reason: "documents",
      cta: null,
      from: "doc.x",
      uniqueViewers: null,
      identifiedViewers: null,
    });
    expect(parseFunnelBody({ event: "cta_clicked", cta: "pack" })).toMatchObject({ event: "cta_clicked", cta: "pack" });
    expect(parseFunnelBody({ event: "teaser_shown", uniqueViewers: 20.7, identifiedViewers: 9 })).toMatchObject({
      event: "teaser_shown",
      uniqueViewers: 20,
      identifiedViewers: 9,
    });
  });

  test("the counts are read for teaser_shown only, and must be counts", () => {
    expect(parseFunnelBody({ event: "modal_shown", uniqueViewers: 5 })).toMatchObject({ uniqueViewers: null });
    expect(parseFunnelBody({ event: "teaser_shown", uniqueViewers: -1 })).toMatch(/uniqueViewers must be a count/);
    expect(parseFunnelBody({ event: "teaser_shown", identifiedViewers: "9" })).toMatch(/identifiedViewers must be a count/);
  });

  test("refuses an unknown event, an unknown cta, a click without a cta, and a long reason", () => {
    expect(parseFunnelBody({ event: "purchased" })).toMatch(/event must be/);
    expect(parseFunnelBody({ event: "cta_clicked", cta: "buy" })).toMatch(/cta must be/);
    expect(parseFunnelBody({ event: "cta_clicked" })).toMatch(/cta is required/);
    expect(parseFunnelBody({ event: "modal_shown", reason: "x".repeat(65) })).toMatch(/reason must be/);
    expect(parseFunnelBody(null)).toMatch(/JSON object/);
  });
});

describe("POST /api/funnel", () => {
  beforeEach(() => {
    mocks.resolveActor.mockReset();
    mocks.recordActivity.mockClear();
    mocks.rateLimit.mockClear();
  });

  test("401 for a temp workspace and for an API key; nothing written", async () => {
    mocks.resolveActor.mockResolvedValueOnce({ kind: "temp", userId: USER_ID, orgId: ORG_ID });
    expect((await POST(post({ event: "modal_shown" }))).status).toBe(401);
    mocks.resolveActor.mockResolvedValueOnce({ ...USER, viaApiKey: { keyId: "k", scopes: ["read"] } });
    expect((await POST(post({ event: "modal_shown" }))).status).toBe(401);
    expect(mocks.recordActivity).not.toHaveBeenCalled();
  });

  test("400 for a bad body; nothing written", async () => {
    mocks.resolveActor.mockResolvedValue(USER);
    expect((await POST(post({ event: "nope" }))).status).toBe(400);
    expect((await POST(post("not json"))).status).toBe(400);
    expect(mocks.recordActivity).not.toHaveBeenCalled();
  });

  test("200 writes one funnel row with reason, cta and from in meta", async () => {
    mocks.resolveActor.mockResolvedValue(USER);
    const res = await POST(post({ event: "cta_clicked", reason: "analytics_history", cta: "upgrade", from: "doc.x.metrics" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.recordActivity).toHaveBeenCalledTimes(1);
    expect((mocks.recordActivity.mock.calls as unknown[][])[0][0]).toMatchObject({
      orgId: ORG_ID,
      userId: USER_ID,
      actorKind: "user",
      type: "funnel.cta_clicked",
      meta: { reason: "analytics_history", cta: "upgrade", from: "doc.x.metrics" },
    });
    expect(mocks.rateLimit).toHaveBeenCalledWith(expect.objectContaining({ key: `funnel:${USER_ID}` }));
  });

  test("teaser_shown maps to funnel.teaser_shown and carries the counts", async () => {
    mocks.resolveActor.mockResolvedValue(USER);
    await POST(post({ event: "teaser_shown", reason: "analytics_history", from: "doc.x.metrics", uniqueViewers: 20, identifiedViewers: 9 }));
    expect((mocks.recordActivity.mock.calls as unknown[][])[0][0]).toMatchObject({
      type: "funnel.teaser_shown",
      meta: { reason: "analytics_history", cta: null, from: "doc.x.metrics", uniqueViewers: 20, identifiedViewers: 9 },
    });
  });

  test("modal_shown maps to funnel.modal_shown with a null cta", async () => {
    mocks.resolveActor.mockResolvedValue(USER);
    await POST(post({ event: "modal_shown", reason: "exhausted", from: "out_of_credits" }));
    expect((mocks.recordActivity.mock.calls as unknown[][])[0][0]).toMatchObject({
      type: "funnel.modal_shown",
      meta: { reason: "exhausted", cta: null, from: "out_of_credits" },
    });
  });
});
