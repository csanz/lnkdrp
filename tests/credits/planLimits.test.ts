import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Mutable fixtures the mocked models read from. Each test sets the plan status, usage counts and
 * grace window it needs; `beforeEach` resets them to an empty Free workspace.
 */
const state = {
  subscriptionStatus: null as string | null,
  activeLinks: 0,
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
  DocModel: { countDocuments: vi.fn(async () => state.activeLinks) },
}));

vi.mock("@/lib/models/Project", () => ({
  ProjectModel: { countDocuments: vi.fn(async () => state.projects) },
}));

vi.mock("@/lib/models/OrgMembership", () => ({
  OrgMembershipModel: { countDocuments: vi.fn(async () => state.members) },
}));

import {
  FREE_ACTIVE_LINKS,
  FREE_ANALYTICS_DAYS,
  FREE_PROJECTS,
  LIMIT_GRACE_DAYS,
  PRO_INCLUDED_COLLABORATORS,
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
  state.activeLinks = 0;
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
      activeLinks: FREE_ACTIVE_LINKS,
      projects: FREE_PROJECTS,
      analyticsDays: FREE_ANALYTICS_DAYS,
      collaborators: 0,
    });
  });

  test("pro is unlimited with one included collaborator", () => {
    expect(limitsForPlan("pro")).toEqual({
      plan: "pro",
      activeLinks: null,
      projects: null,
      analyticsDays: null,
      collaborators: PRO_INCLUDED_COLLABORATORS,
    });
  });

  test("returns a copy so callers cannot mutate the table", () => {
    const a = limitsForPlan("free");
    a.activeLinks = 99;
    expect(limitsForPlan("free").activeLinks).toBe(FREE_ACTIVE_LINKS);
  });
});

describe("billing/planLimits getWorkspaceUsage", () => {
  test("reports the three counts", async () => {
    state.activeLinks = 2;
    state.projects = 1;
    state.members = 3;
    expect(await getWorkspaceUsage(ORG_ID)).toEqual({ activeLinks: 2, projects: 1, members: 3 });
  });

  test("rejects a malformed orgId", async () => {
    await expect(getWorkspaceUsage("nope")).rejects.toThrow(/Invalid orgId/);
  });
});

describe("billing/planLimits checkLimit", () => {
  test("under the cap → ok without warning", async () => {
    state.activeLinks = FREE_ACTIVE_LINKS - 1;
    expect(await checkLimit(ORG_ID, "active_links")).toEqual({ ok: true, warning: null });
  });

  test("exactly at the cap after adding one → ok (used == max is allowed)", async () => {
    state.projects = FREE_PROJECTS - 1;
    expect(await checkLimit(ORG_ID, "projects")).toEqual({ ok: true, warning: null });
  });

  test("over the cap with no grace → blocked with the plan_limit shape", async () => {
    state.activeLinks = FREE_ACTIVE_LINKS;
    const check = await checkLimit(ORG_ID, "active_links");
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error("expected blocked");
    expect(check).toEqual({
      ok: false,
      code: "plan_limit",
      limit: "active_links",
      used: FREE_ACTIVE_LINKS + 1,
      max: FREE_ACTIVE_LINKS,
      grace: null,
      upgradeUrl: "/pricing",
      message: `Free workspaces can have ${FREE_ACTIVE_LINKS} active share links. Disable one or upgrade to Pro.`,
    });
  });

  test("`adding` is honoured (bulk create)", async () => {
    state.activeLinks = 0;
    const check = await checkLimit(ORG_ID, "active_links", { adding: FREE_ACTIVE_LINKS + 2 });
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error("expected blocked");
    expect(check.used).toBe(FREE_ACTIVE_LINKS + 2);
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
    state.activeLinks = FREE_ACTIVE_LINKS + 5;

    const check = await checkLimit(ORG_ID, "active_links");
    expect(check).toEqual({
      ok: true,
      warning: {
        limit: "active_links",
        used: FREE_ACTIVE_LINKS + 6,
        max: FREE_ACTIVE_LINKS,
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
    state.activeLinks = FREE_ACTIVE_LINKS;

    const check = await checkLimit(ORG_ID, "active_links");
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error("expected blocked");
    expect(check.code).toBe("plan_limit");
    expect(check.grace?.blockedAt).toBe(blockedAt.toISOString());
  });

  test.each(["active", "trialing", "ACTIVE"])("pro (%s) → unlimited links and projects, collaborators capped at the included seat", async (status) => {
    state.subscriptionStatus = status;
    state.activeLinks = 500;
    state.projects = 50;
    state.members = 20;
    expect(await checkLimit(ORG_ID, "active_links")).toEqual({ ok: true, warning: null });
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
    state.activeLinks = FREE_ACTIVE_LINKS;
    expect((await checkLimit(ORG_ID, "active_links")).ok).toBe(false);
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
    state.activeLinks = FREE_ACTIVE_LINKS;
    const check = await checkLimit(ORG_ID, "active_links");
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
      limit: "active_links",
      used: FREE_ACTIVE_LINKS + 1,
      max: FREE_ACTIVE_LINKS,
      grace: null,
      upgradeUrl: "/pricing",
    });
  });
});
