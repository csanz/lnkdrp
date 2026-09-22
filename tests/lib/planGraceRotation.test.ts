import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

/**
 * The plan-limit grace sweep is budgeted (`?limit=`, 500 per hourly run in production). It used to
 * fill that budget with `sort({ _id: -1 })`, i.e. the newest workspaces, every run: once the Org
 * collection held more workspaces than the budget, the older ones were never scanned, never got a
 * `plan.grace_started` row, never got the email and never got the 14 days, they just hit a bare
 * 402 on the next upload. These tests pin the rotation that replaced it.
 *
 * The mocked `OrgModel` honours the real query semantics the sweep relies on (filter, sort with
 * null-first ascending, limit), so a regression to any fixed-prefix sort fails here.
 */

type FakeGrace = { startedAt: Date; endsAt: Date; blockedAt: Date | null; remindersSent: Date[] } | null;

type FakeOrg = {
  _id: Types.ObjectId;
  name: string;
  planGrace: FakeGrace;
  planLimitsScannedAt: Date | null;
  isDeleted: boolean;
};

/** Six workspaces, oldest (`orgs[0]`) to newest (`orgs[5]`); ObjectIds are creation-ordered. */
const state = {
  orgs: [] as FakeOrg[],
  /** Shared-document count per orgId, read by the mocked `DocModel.countDocuments`. */
  documents: new Map<string, number>(),
};

function orgId(n: number): Types.ObjectId {
  return new Types.ObjectId(`507f1f77bcf86cd7994390${String(10 + n).padStart(2, "0")}`);
}

function matches(org: FakeOrg, filter: Record<string, any>): boolean {
  if (filter.isDeleted && org.isDeleted) return false;
  if ("planGrace" in filter) {
    const want = filter.planGrace;
    if (want === null && org.planGrace !== null) return false;
    if (want && typeof want === "object" && "$ne" in want && org.planGrace === null) return false;
  }
  return true;
}

function sortValue(org: FakeOrg, key: string): number | string | null {
  if (key === "_id") return String(org._id);
  if (key === "planLimitsScannedAt") return org.planLimitsScannedAt ? org.planLimitsScannedAt.getTime() : null;
  if (key === "planGrace.endsAt") return org.planGrace ? org.planGrace.endsAt.getTime() : null;
  throw new Error(`unsupported sort key: ${key}`);
}

/** Mongo ordering: null/missing sorts before values ascending (and after them descending). */
function compare(a: FakeOrg, b: FakeOrg, spec: Record<string, number>): number {
  for (const [key, dir] of Object.entries(spec)) {
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    if (av === bv) continue;
    if (av === null) return -1 * dir;
    if (bv === null) return 1 * dir;
    return (av < bv ? -1 : 1) * dir;
  }
  return 0;
}

function find(filter: Record<string, any>) {
  let rows = state.orgs.filter((o) => matches(o, filter));
  const chain = {
    select: () => chain,
    sort: (spec: Record<string, number>) => {
      rows = [...rows].sort((a, b) => compare(a, b, spec));
      return chain;
    },
    limit: (n: number) => {
      rows = rows.slice(0, n);
      return chain;
    },
    lean: async () => rows.map((o) => ({ _id: o._id, name: o.name, planGrace: o.planGrace })),
  };
  return chain;
}

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => {}) }));

vi.mock("@/lib/models/Org", () => ({
  OrgModel: {
    find: vi.fn((filter: Record<string, any>) => find(filter)),
    updateOne: vi.fn(async (filter: Record<string, any>, update: Record<string, any>) => {
      const org = state.orgs.find((o) => String(o._id) === String(filter._id));
      if (org) org.planGrace = update.$set.planGrace;
      return { acknowledged: true };
    }),
    updateMany: vi.fn(async (filter: Record<string, any>, update: Record<string, any>) => {
      const ids = (filter._id?.$in ?? []).map((id: unknown) => String(id));
      for (const org of state.orgs) {
        if (ids.includes(String(org._id))) org.planLimitsScannedAt = update.$set.planLimitsScannedAt;
      }
      return { acknowledged: true };
    }),
  },
}));

vi.mock("@/lib/models/Subscription", () => ({
  SubscriptionModel: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
}));

vi.mock("@/lib/models/OrgMembership", () => ({
  OrgMembershipModel: {
    // No owners: `loadOwners` returns nothing and no email is ever composed or sent.
    find: () => ({ select: () => ({ lean: async () => [] }) }),
    countDocuments: async () => 1,
  },
}));

vi.mock("@/lib/models/User", () => ({
  UserModel: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
}));

vi.mock("@/lib/models/Doc", () => ({
  DocModel: {
    countDocuments: async (filter: Record<string, any>) => state.documents.get(String(filter.orgId)) ?? 0,
  },
}));

vi.mock("@/lib/models/Project", () => ({ ProjectModel: { countDocuments: async () => 0 } }));

vi.mock("@/lib/activity/log", () => ({ recordActivity: vi.fn(async () => {}) }));

// `vi.hoisted`: the mock factory runs before this file's top-level consts exist.
const emails = vi.hoisted(() => ({ sendPlanLimitEmail: vi.fn(async () => {}) }));
vi.mock("@/lib/email/sendPlanLimitEmail", () => ({ sendPlanLimitEmail: emails.sendPlanLimitEmail }));

vi.mock("@/lib/urls", () => ({ getMetadataBaseUrl: () => "http://localhost:3001" }));

import { runPlanLimitsGraceSweep } from "@/lib/billing/planGrace";
import { FREE_DOCUMENTS } from "@/lib/billing/planLimits";

const T0 = new Date("2026-09-22T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

function graceOf(n: number): FakeGrace {
  return state.orgs[n].planGrace;
}

beforeEach(() => {
  emails.sendPlanLimitEmail.mockClear();
  state.documents.clear();
  state.orgs = Array.from({ length: 6 }, (_, n) => ({
    _id: orgId(n),
    name: `Workspace ${n}`,
    planGrace: null,
    planLimitsScannedAt: null,
    isDeleted: false,
  }));
  // The oldest and the newest workspace are both over the Free document cap. Everyone else is fine.
  state.documents.set(String(orgId(0)), FREE_DOCUMENTS + 1);
  state.documents.set(String(orgId(5)), FREE_DOCUMENTS + 1);
});

describe("plan-limits grace sweep rotation", () => {
  test("the budget walks the collection, so an old over-limit workspace still gets its window", async () => {
    // Budget of 4 against 6 workspaces: no single run can see all of them.
    const first = await runPlanLimitsGraceSweep({ now: T0, limit: 4 });
    const second = await runPlanLimitsGraceSweep({ now: new Date(T0.getTime() + HOUR_MS), limit: 4 });

    expect(first.scanned).toBe(4);
    expect(second.scanned).toBe(4);

    // Both ends of the collection were reached within two runs. With the old newest-first prefix
    // the oldest workspace was invisible to every run and this is null for ever.
    expect(graceOf(0)).not.toBeNull();
    expect(graceOf(5)).not.toBeNull();
    expect(first.started + second.started).toBe(2);

    // Workspaces under the limits never get a window, however often they are scanned.
    expect(graceOf(1)).toBeNull();
    expect(graceOf(2)).toBeNull();
    expect(graceOf(3)).toBeNull();
    expect(graceOf(4)).toBeNull();

    // Nothing was emailed (no owners in these fixtures) and no run errored.
    expect(emails.sendPlanLimitEmail).not.toHaveBeenCalled();
    expect(first.errors + second.errors).toBe(0);
  });

  test("a dry run neither writes grace nor advances the rotation", async () => {
    const dry = await runPlanLimitsGraceSweep({ now: T0, limit: 4, dryRun: true });
    expect(dry.started).toBe(1);
    expect(graceOf(0)).toBeNull();
    expect(state.orgs.every((o) => o.planLimitsScannedAt === null)).toBe(true);

    // The real run that follows still starts at the front of the queue.
    const real = await runPlanLimitsGraceSweep({ now: new Date(T0.getTime() + HOUR_MS), limit: 4 });
    expect(real.started).toBe(1);
    expect(graceOf(0)).not.toBeNull();
  });
});
