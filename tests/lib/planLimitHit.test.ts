/**
 * `planLimitResponse` records the wall it answers with (Phase 4.1 of the pricing plan).
 *
 * The 402 body must not change: every client branches on `code: "plan_limit"` and reads
 * `limit/used/max/grace` from it. What is new is the `plan.limit_reached` row, written once per
 * workspace and limit inside `LIMIT_HIT_DEDUPE_MS`, and only when the caller says who hit it.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordActivity: vi.fn(async () => undefined),
  connectMongo: vi.fn(async () => undefined),
}));

vi.mock("@/lib/activity/log", () => ({ recordActivity: mocks.recordActivity }));
vi.mock("@/lib/mongodb", () => ({ connectMongo: mocks.connectMongo }));
vi.mock("@/lib/models/Org", () => ({ OrgModel: {} }));
vi.mock("@/lib/models/OrgMembership", () => ({ OrgMembershipModel: {} }));
vi.mock("@/lib/models/Doc", () => ({ DocModel: {} }));
vi.mock("@/lib/models/Project", () => ({ ProjectModel: {} }));
vi.mock("@/lib/models/Subscription", () => ({ SubscriptionModel: {} }));

import {
  LIMIT_HIT_DEDUPE_MS,
  planLimitResponse,
  resetLimitHitDedupeForTests,
  type PlanLimitBlocked,
} from "@/lib/billing/planLimits";

const ORG_A = "66f0a2b3c4d5e6f7a8b9c0d1";
const ORG_B = "66f0a2b3c4d5e6f7a8b9c0d2";
const USER = "66f0a2b3c4d5e6f7a8b9c0d3";

const blocked: PlanLimitBlocked = {
  ok: false,
  code: "plan_limit",
  limit: "documents",
  used: 3,
  requested: 1,
  max: 3,
  grace: null,
  upgradeUrl: "/pricing",
  message: "Free workspaces can share 3 documents.",
};

describe("planLimitResponse", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T10:00:00Z"));
    resetLimitHitDedupeForTests();
    mocks.recordActivity.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("the 402 body is unchanged, with or without a hit context", async () => {
    const plain = planLimitResponse(blocked);
    const withHit = planLimitResponse(blocked, { orgId: ORG_A, userId: USER });
    expect(plain.status).toBe(402);
    expect(withHit.status).toBe(402);
    const body = await withHit.json();
    expect(body).toEqual({ error: blocked.message, ...blocked });
    expect(await plain.json()).toEqual(body);
    expect(withHit.headers.get("cache-control")).toBe("no-store");
  });

  test("no context, no row", () => {
    planLimitResponse(blocked);
    expect(mocks.recordActivity).not.toHaveBeenCalled();
  });

  test("records plan.limit_reached with limit, used, max and grace", () => {
    planLimitResponse(blocked, { orgId: ORG_A, userId: USER, docId: ORG_B, meta: { via: "invite_claim" } });
    expect(mocks.recordActivity).toHaveBeenCalledTimes(1);
    expect((mocks.recordActivity.mock.calls as unknown[][])[0][0]).toMatchObject({
      orgId: ORG_A,
      userId: USER,
      actorKind: "user",
      type: "plan.limit_reached",
      docId: ORG_B,
      meta: { via: "invite_claim", limit: "documents", used: 3, max: 3, grace: false },
    });
  });

  test("the same workspace and limit inside the window is one row; another limit or workspace is another", () => {
    planLimitResponse(blocked, { orgId: ORG_A });
    planLimitResponse(blocked, { orgId: ORG_A });
    expect(mocks.recordActivity).toHaveBeenCalledTimes(1);
    planLimitResponse({ ...blocked, limit: "analytics_history", used: 0, max: 0 }, { orgId: ORG_A });
    expect(mocks.recordActivity).toHaveBeenCalledTimes(2);
    planLimitResponse(blocked, { orgId: ORG_B });
    expect(mocks.recordActivity).toHaveBeenCalledTimes(3);
  });

  test("after the window the same hit is recorded again", () => {
    planLimitResponse(blocked, { orgId: ORG_A });
    vi.setSystemTime(new Date(Date.now() + LIMIT_HIT_DEDUPE_MS + 1));
    planLimitResponse(blocked, { orgId: ORG_A });
    expect(mocks.recordActivity).toHaveBeenCalledTimes(2);
  });

  test("a grace window that was open is recorded as grace: true", () => {
    planLimitResponse(
      { ...blocked, grace: { startedAt: "2026-09-01T00:00:00Z", endsAt: "2026-09-20T00:00:00Z", blockedAt: "2026-09-20T00:00:00Z" } },
      { orgId: ORG_A },
    );
    expect((mocks.recordActivity.mock.calls as unknown[][])[0][0]).toMatchObject({ meta: { grace: true } });
  });
});
