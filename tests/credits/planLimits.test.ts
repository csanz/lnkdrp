import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Mutable fixtures the mocked models read from. Each test sets the plan status, usage counts and
 * grace window it needs; `beforeEach` resets them to an empty Free workspace.
 */
const state = {
  subscriptionStatus: null as string | null,
  documents: 0,
  projects: 0,
  members: 1,
  planGrace: null as { startedAt: Date; endsAt: Date; blockedAt: Date | null } | null,
};

/** `Model.findOne(...).select(...).lean()` chain resolving to `value()`. */
function findOneChain(value: () => unknown) {
  return vi.fn(() => ({
    select: vi.fn(() => ({
      lean: vi.fn(async () => value()),
    })),
  }));
}

vi.mock("@/lib/mongodb", () => ({
  connectMongo: vi.fn(async () => {}),
}));

vi.mock("@/lib/models/Subscription", () => ({
  SubscriptionModel: {
    findOne: findOneChain(() => (state.subscriptionStatus ? { status: state.subscriptionStatus } : null)),
  },
}));

vi.mock("@/lib/models/Org", () => ({
  OrgModel: {
    findOne: findOneChain(() => ({ planGrace: state.planGrace })),
  },
}));

vi.mock("@/lib/models/Doc", () => ({
  DocModel: { countDocuments: vi.fn(async () => state.documents) },
}));

// No `@/lib/share/links` stub any more: `getWorkspaceUsage` counts shared *documents* through
// `DocModel` above. It briefly counted links, which is what told a workspace holding two documents
// that it was at "11 of 3" — see `FREE_DOCUMENTS`.

vi.mock("@/lib/models/Project", () => ({
  ProjectModel: { countDocuments: vi.fn(async () => state.projects) },
}));

vi.mock("@/lib/models/OrgMembership", () => ({
  OrgMembershipModel: { countDocuments: vi.fn(async () => state.members) },
}));

import {
  FREE_DOCUMENTS,
  FREE_ANALYTICS_DAYS,
  FREE_PROJECTS,
  LIMIT_GRACE_DAYS,
  PRO_INCLUDED_COLLABORATORS,
  analyticsTierForPlan,
  checkLimit,
  clampAnalyticsDays,
  getWorkspaceUsage,
  limitsForPlan,
  planLimitResponse,
} from "@/lib/billing/planLimits";

const ORG_ID = "507f1f77bcf86cd799439011";
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  state.subscriptionStatus = null;
  state.documents = 0;
  state.projects = 0;
  state.members = 1;
  state.planGrace = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("billing/planLimits limitsForPlan", () => {
  test("free caps links/projects/analytics and allows no collaborators", () => {
    expect(limitsForPlan("free")).toEqual({
      plan: "free",
      documents: FREE_DOCUMENTS,
      projects: FREE_PROJECTS,
      analyticsDays: FREE_ANALYTICS_DAYS,
      collaborators: 0,
    });
  });

  test("pro is unlimited with one included collaborator", () => {
    expect(limitsForPlan("pro")).toEqual({
      plan: "pro",
      documents: null,
      projects: null,
      analyticsDays: null,
      collaborators: PRO_INCLUDED_COLLABORATORS,
    });
  });

  test("returns a copy so callers cannot mutate the table", () => {
    const a = limitsForPlan("free");
    a.documents = 99;
    expect(limitsForPlan("free").documents).toBe(FREE_DOCUMENTS);
  });
});

describe("billing/planLimits getWorkspaceUsage", () => {
  test("reports the three counts", async () => {
    state.documents = 2;
    state.projects = 1;
    state.members = 3;
    expect(await getWorkspaceUsage(ORG_ID)).toEqual({ documents: 2, projects: 1, members: 3 });
  });

  test("rejects a malformed orgId", async () => {
    await expect(getWorkspaceUsage("nope")).rejects.toThrow(/Invalid orgId/);
  });
});

describe("billing/planLimits checkLimit", () => {
  test("under the cap → ok without warning", async () => {
    state.documents = FREE_DOCUMENTS - 1;
    expect(await checkLimit(ORG_ID, "documents")).toEqual({ ok: true, warning: null });
  });

  test("exactly at the cap after adding one → ok (used == max is allowed)", async () => {
    state.projects = FREE_PROJECTS - 1;
    expect(await checkLimit(ORG_ID, "projects")).toEqual({ ok: true, warning: null });
  });

  test("over the cap with no grace → blocked with the plan_limit shape", async () => {
    state.documents = FREE_DOCUMENTS;
    const check = await checkLimit(ORG_ID, "documents");
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error("expected blocked");
    expect(check).toEqual({
      ok: false,
      code: "plan_limit",
      limit: "documents",
      used: FREE_DOCUMENTS + 1,
      max: FREE_DOCUMENTS,
      grace: null,
      upgradeUrl: "/pricing",
      message: `Free workspaces can share ${FREE_DOCUMENTS} documents. Archive one or upgrade to Pro.`,
    });
  });

  test("`adding` is honoured (bulk create)", async () => {
    state.documents = 0;
    const check = await checkLimit(ORG_ID, "documents", { adding: FREE_DOCUMENTS + 2 });
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error("expected blocked");
    expect(check.used).toBe(FREE_DOCUMENTS + 2);
  });

  test("collaborators: Free workspace with only the owner cannot add one", async () => {
    state.members = 1;
    const check = await checkLimit(ORG_ID, "collaborators");
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error("expected blocked");
    expect(check.limit).toBe("collaborators");
    expect(check.used).toBe(1);
    expect(check.max).toBe(0);
    expect(check.message).toMatch(/single-user/i);
  });

  test("grace active (unblocked, before endsAt) → ok with warning", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T12:00:00.000Z"));
    const startedAt = new Date("2026-09-10T00:00:00.000Z");
    const endsAt = new Date(startedAt.getTime() + LIMIT_GRACE_DAYS * DAY_MS);
    state.planGrace = { startedAt, endsAt, blockedAt: null };
    state.documents = FREE_DOCUMENTS + 5;

    const check = await checkLimit(ORG_ID, "documents");
    expect(check).toEqual({
      ok: true,
      warning: {
        limit: "documents",
        used: FREE_DOCUMENTS + 6,
        max: FREE_DOCUMENTS,
        grace: { startedAt: startedAt.toISOString(), endsAt: endsAt.toISOString(), blockedAt: null },
      },
    });
  });

  test("grace expired (now >= endsAt) → blocked, grace echoed", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-08-01T00:00:00.000Z");
    const endsAt = new Date(startedAt.getTime() + LIMIT_GRACE_DAYS * DAY_MS);
    vi.setSystemTime(endsAt);
    state.planGrace = { startedAt, endsAt, blockedAt: null };
    state.projects = FREE_PROJECTS;

    const check = await checkLimit(ORG_ID, "projects");
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error("expected blocked");
    expect(check.grace).toEqual({ startedAt: startedAt.toISOString(), endsAt: endsAt.toISOString(), blockedAt: null });
  });

  test("grace blocked (blockedAt set) → blocked even before endsAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T12:00:00.000Z"));
    const startedAt = new Date("2026-09-10T00:00:00.000Z");
    const endsAt = new Date(startedAt.getTime() + LIMIT_GRACE_DAYS * DAY_MS);
    const blockedAt = new Date("2026-09-11T00:00:00.000Z");
    state.planGrace = { startedAt, endsAt, blockedAt };
    state.documents = FREE_DOCUMENTS;

    const check = await checkLimit(ORG_ID, "documents");
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error("expected blocked");
    expect(check.code).toBe("plan_limit");
    expect(check.grace?.blockedAt).toBe(blockedAt.toISOString());
  });

  test.each(["active", "trialing", "ACTIVE"])("pro (%s) → unlimited links and projects, collaborators capped at the included seat", async (status) => {
    state.subscriptionStatus = status;
    state.documents = 500;
    state.projects = 50;
    state.members = 20;
    expect(await checkLimit(ORG_ID, "documents")).toEqual({ ok: true, warning: null });
    expect(await checkLimit(ORG_ID, "projects")).toEqual({ ok: true, warning: null });
    const collab = await checkLimit(ORG_ID, "collaborators");
    expect(collab.ok).toBe(false);
    if (collab.ok) throw new Error("expected blocked");
    expect(collab.code).toBe("plan_limit");
    expect(collab.max).toBe(PRO_INCLUDED_COLLABORATORS);
    expect(collab.grace).toBeNull();
    expect(collab.message).toMatch(/Pro includes 1 collaborator/);
  });

  test("pro with only the owner may add the included collaborator", async () => {
    state.subscriptionStatus = "active";
    state.members = 1;
    expect(await checkLimit(ORG_ID, "collaborators")).toEqual({ ok: true, warning: null });
  });

  test.each(["canceled", "past_due", "free"])("non-pro status (%s) is Free", async (status) => {
    state.subscriptionStatus = status;
    state.documents = FREE_DOCUMENTS;
    expect((await checkLimit(ORG_ID, "documents")).ok).toBe(false);
  });
});

describe("billing/planLimits checkLimit version_history (feature gate)", () => {
  test("free → blocked with the Pro-feature message, no usage, no grace", async () => {
    const check = await checkLimit(ORG_ID, "version_history");
    expect(check).toEqual({
      ok: false,
      code: "plan_limit",
      limit: "version_history",
      used: 0,
      max: 0,
      grace: null,
      upgradeUrl: "/pricing",
      message: "Letting recipients browse versions is a Pro feature.",
    });
  });

  test("free inside an active grace window is still blocked (grace never applies to a gate)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T12:00:00.000Z"));
    const startedAt = new Date("2026-09-10T00:00:00.000Z");
    const endsAt = new Date(startedAt.getTime() + LIMIT_GRACE_DAYS * DAY_MS);
    state.planGrace = { startedAt, endsAt, blockedAt: null };

    const check = await checkLimit(ORG_ID, "version_history");
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error("expected blocked");
    expect(check.grace).toBeNull();
  });

  test("free: `adding` is ignored (not a count)", async () => {
    const check = await checkLimit(ORG_ID, "version_history", { adding: 5 });
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error("expected blocked");
    expect(check.used).toBe(0);
    expect(check.max).toBe(0);
  });

  test.each(["active", "trialing"])("pro (%s) → ok without warning", async (status) => {
    state.subscriptionStatus = status;
    expect(await checkLimit(ORG_ID, "version_history")).toEqual({ ok: true, warning: null });
  });

  test("blocked check turns into a 402 via planLimitResponse", async () => {
    const check = await checkLimit(ORG_ID, "version_history");
    if (check.ok) throw new Error("expected blocked");
    const res = planLimitResponse(check);
    expect(res.status).toBe(402);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("plan_limit");
    expect(body.limit).toBe("version_history");
    expect(body.error).toBe("Letting recipients browse versions is a Pro feature.");
  });
});

describe("billing/planLimits checkLimit analytics_history (feature gate)", () => {
  test("free → blocked with the deep-analytics message, no usage, no grace", async () => {
    const check = await checkLimit(ORG_ID, "analytics_history");
    expect(check).toEqual({
      ok: false,
      code: "plan_limit",
      limit: "analytics_history",
      used: 0,
      max: 0,
      grace: null,
      upgradeUrl: "/pricing",
      message: "Deep analytics are a Pro feature.",
    });
  });

  test("free inside an active grace window is still blocked (grace never applies to a gate)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T12:00:00.000Z"));
    const startedAt = new Date("2026-09-10T00:00:00.000Z");
    const endsAt = new Date(startedAt.getTime() + LIMIT_GRACE_DAYS * DAY_MS);
    state.planGrace = { startedAt, endsAt, blockedAt: null };

    const check = await checkLimit(ORG_ID, "analytics_history");
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error("expected blocked");
    expect(check.grace).toBeNull();
  });

  test("free: `adding` is ignored (not a count)", async () => {
    const check = await checkLimit(ORG_ID, "analytics_history", { adding: 3 });
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error("expected blocked");
    expect(check.used).toBe(0);
    expect(check.max).toBe(0);
  });

  test.each(["active", "trialing"])("pro (%s) → ok without warning", async (status) => {
    state.subscriptionStatus = status;
    expect(await checkLimit(ORG_ID, "analytics_history")).toEqual({ ok: true, warning: null });
  });

  test.each(["canceled", "past_due"])("non-pro status (%s) is blocked", async (status) => {
    state.subscriptionStatus = status;
    expect((await checkLimit(ORG_ID, "analytics_history")).ok).toBe(false);
  });

  test("blocked check turns into a 402 via planLimitResponse", async () => {
    const check = await checkLimit(ORG_ID, "analytics_history");
    if (check.ok) throw new Error("expected blocked");
    const res = planLimitResponse(check);
    expect(res.status).toBe(402);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("plan_limit");
    expect(body.limit).toBe("analytics_history");
    expect(body.error).toBe("Deep analytics are a Pro feature.");
  });
});

describe("billing/planLimits analyticsTierForPlan", () => {
  test("free is basic, pro is deep", () => {
    expect(analyticsTierForPlan("free")).toBe("basic");
    expect(analyticsTierForPlan("pro")).toBe("deep");
  });
});

describe("billing/planLimits clampAnalyticsDays", () => {
  test("free clamps to FREE_ANALYTICS_DAYS", () => {
    expect(clampAnalyticsDays("free", 60)).toBe(FREE_ANALYTICS_DAYS);
    expect(clampAnalyticsDays("free", FREE_ANALYTICS_DAYS)).toBe(FREE_ANALYTICS_DAYS);
    expect(clampAnalyticsDays("free", 3)).toBe(3);
  });

  test("pro passes the request through", () => {
    expect(clampAnalyticsDays("pro", 60)).toBe(60);
    expect(clampAnalyticsDays("pro", 15)).toBe(15);
  });

  test("never returns less than one day", () => {
    expect(clampAnalyticsDays("free", 0)).toBe(1);
    expect(clampAnalyticsDays("pro", Number.NaN)).toBe(1);
  });
});

describe("billing/planLimits planLimitResponse", () => {
  test("returns 402 with the check as the body and error mirroring message", async () => {
    state.documents = FREE_DOCUMENTS;
    const check = await checkLimit(ORG_ID, "documents");
    if (check.ok) throw new Error("expected blocked");

    const res = planLimitResponse(check);
    expect(res.status).toBe(402);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      ok: false,
      error: check.message,
      message: check.message,
      code: "plan_limit",
      limit: "documents",
      used: FREE_DOCUMENTS + 1,
      max: FREE_DOCUMENTS,
      grace: null,
      upgradeUrl: "/pricing",
    });
  });
});
