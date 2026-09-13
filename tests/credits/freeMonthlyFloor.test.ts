import mongoose from "mongoose";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Free monthly floor: on the first evaluation in each UTC month a personal Free workspace's trial
 * bucket is raised to `max(trial, 10)`, at most once per month (`freeFloorMonth` marker), never for
 * Pro (active/trialing) or team workspaces. Applied from the reserve path (Mongo store, inside the
 * reservation transaction), the dashboard snapshot, and the cycle-reconcile cron.
 *
 * Models are replaced by a single in-memory balance row + ledger array that honour the operators the
 * code relies on (`$ne` marker claim, `$set`, `$max`, `$setOnInsert`).
 */
type Row = Record<string, unknown>;

const { state, orgFindOne } = vi.hoisted(() => {
  const state = {
    orgType: "personal" as "personal" | "team",
    subscriptionStatus: null as string | null,
    row: null as Row | null,
    ledger: [] as Row[],
  };
  const orgFindOne = { calls: 0 };
  return { state, orgFindOne };
});

/** True when `filter.freeFloorMonth` (a `{ $ne }` clause, when present) matches the row. */
function markerMatches(row: Row, filter: Record<string, unknown>): boolean {
  const clause = filter.freeFloorMonth as { $ne?: unknown } | undefined;
  if (!clause || typeof clause !== "object" || !("$ne" in clause)) return true;
  return (row.freeFloorMonth ?? null) !== clause.$ne;
}

function applyUpdate(row: Row, update: Record<string, Record<string, unknown>>) {
  Object.assign(row, update.$set ?? {});
  for (const [k, v] of Object.entries(update.$max ?? {})) {
    const cur = typeof row[k] === "number" ? (row[k] as number) : 0;
    row[k] = Math.max(cur, v as number);
  }
}

/** Query builder stand-in: `.select()` / `.session()` chain, `.lean()` or `await` resolves `value()`. */
function chain(value: () => unknown) {
  const q: Record<string, unknown> = {
    select: () => q,
    session: () => q,
    lean: async () => value(),
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(value).then(resolve, reject),
  };
  return q;
}

const fakeSession = {
  withTransaction: async (fn: () => Promise<unknown>) => await fn(),
  endSession: async () => {},
};

vi.mock("@/lib/mongodb", () => ({ connectMongo: async () => {} }));

vi.mock("@/lib/models/Org", () => ({
  OrgModel: {
    findOne: () => {
      orgFindOne.calls += 1;
      return chain(() => ({ type: state.orgType }));
    },
  },
}));

vi.mock("@/lib/models/Subscription", () => ({
  SubscriptionModel: {
    findOne: () => chain(() => (state.subscriptionStatus ? { status: state.subscriptionStatus } : null)),
  },
}));

vi.mock("@/lib/models/WorkspaceCreditBalance", () => ({
  WorkspaceCreditBalanceModel: {
    findOne: () => chain(() => (state.row ? { ...state.row } : null)),
    startSession: async () => fakeSession,
    create: async (docs: Row[]) => {
      state.row = { ...docs[0] };
      return [{ ...state.row }];
    },
    updateOne: async (filter: Record<string, unknown>, update: Record<string, Record<string, unknown>>, opts?: { upsert?: boolean }) => {
      if (!state.row) {
        if (opts?.upsert) state.row = { ...(update.$setOnInsert ?? {}), ...(update.$set ?? {}) };
        return { modifiedCount: 0 };
      }
      if (!markerMatches(state.row, filter)) return { modifiedCount: 0 };
      applyUpdate(state.row, update);
      return { modifiedCount: 1 };
    },
    findOneAndUpdate: (filter: Record<string, unknown>, update: Record<string, Record<string, unknown>>) => {
      let before: Row | null = null;
      if (state.row && markerMatches(state.row, filter)) {
        before = { ...state.row };
        applyUpdate(state.row, update);
      }
      return { lean: async () => before };
    },
  },
}));

vi.mock("@/lib/models/CreditLedger", () => {
  const empty = () => Object.assign(Promise.resolve([]), { session: async () => [] });
  return {
    CreditLedgerModel: {
      findOne: () => chain(() => null),
      aggregate: empty,
      create: async (docs: Row[]) => {
        return docs.map((d) => {
          if (state.ledger.some((l) => l.idempotencyKey === d.idempotencyKey)) {
            throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
          }
          const saved = { _id: `led_${state.ledger.length + 1}`, ...d };
          state.ledger.push(saved);
          return saved;
        });
      },
    },
  };
});

vi.mock("@/lib/models/UsageAggCycle", () => ({ UsageAggCycleModel: { findOne: () => chain(() => null) } }));
vi.mock("@/lib/models/UsageAggDaily", () => ({ UsageAggDailyModel: {} }));

import {
  FREE_MONTHLY_FLOOR_CREDITS,
  FREE_STARTER_CREDITS,
  freeFloorMonth,
  freeFloorMonthKey,
  grantFreeMonthlyFloor,
} from "@/lib/credits/grants";
import { defaultBalanceForWorkspace } from "@/lib/credits/creditService";
import { createMongooseCreditStore } from "@/lib/credits/mongooseStore";
import { createCreditService } from "@/lib/credits/serviceCore";
import { getCreditsSnapshot } from "@/lib/credits/snapshot";

const ORG_ID = "507f1f77bcf86cd799439011";
const USER_ID = "507f1f77bcf86cd799439012";

const SEPT = new Date("2026-09-13T12:00:00.000Z");
const OCT_1 = new Date("2026-10-01T00:05:00.000Z");
const NOV_1 = new Date("2026-11-01T00:05:00.000Z");

function freeRow(trial: number, marker: string | null): Row {
  return {
    workspaceId: new mongoose.Types.ObjectId(ORG_ID),
    trialCreditsRemaining: trial,
    subscriptionCreditsRemaining: 0,
    purchasedCreditsRemaining: 0,
    onDemandEnabled: false,
    onDemandMonthlyLimitCents: 0,
    dailyCreditCap: 15,
    monthlyCreditCap: null,
    perRunCreditCapBasic: 20,
    perRunCreditCapStandard: 60,
    perRunCreditCapAdvanced: 150,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    freeFloorMonth: marker,
  };
}

function floorLedgerRows() {
  return state.ledger.filter((l) => l.eventType === "free_floor_grant");
}

beforeEach(() => {
  state.orgType = "personal";
  state.subscriptionStatus = null;
  state.row = null;
  state.ledger = [];
  orgFindOne.calls = 0;
  vi.spyOn(mongoose, "startSession").mockResolvedValue(fakeSession as unknown as mongoose.ClientSession);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("freeFloorMonthKey", () => {
  test("free:{orgId}:{YYYY-MM} in UTC", () => {
    expect(FREE_MONTHLY_FLOOR_CREDITS).toBe(10);
    expect(freeFloorMonthKey(ORG_ID, new Date("2026-10-31T23:59:59.999Z"))).toBe(`free:${ORG_ID}:2026-10`);
    expect(freeFloorMonthKey(ORG_ID, new Date("2026-11-01T00:00:00.000Z"))).toBe(`free:${ORG_ID}:2026-11`);
    expect(freeFloorMonth(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01");
  });
});

describe("grantFreeMonthlyFloor", () => {
  test("raises to the floor (max, not sum) and writes one ledger row", async () => {
    state.row = freeRow(3, "2026-09");
    const res = await grantFreeMonthlyFloor({ workspaceId: ORG_ID, now: OCT_1 });
    expect(res).toEqual({ applied: true, creditsAdded: 7, monthKey: `free:${ORG_ID}:2026-10`, reason: "applied" });
    expect(state.row.trialCreditsRemaining).toBe(10);
    expect(state.row.freeFloorMonth).toBe("2026-10");
    expect(floorLedgerRows()).toHaveLength(1);
    expect(floorLedgerRows()[0]).toMatchObject({
      eventType: "free_floor_grant",
      actionType: "unknown",
      qualityTier: "basic",
      status: "charged",
      creditsCharged: 0,
      creditsReserved: 0,
      creditsEstimated: 7,
      idempotencyKey: `free:${ORG_ID}:2026-10`,
      userId: null,
    });
  });

  test("a balance above the floor is marked but unchanged, with no ledger row", async () => {
    state.row = freeRow(25, "2026-09");
    const res = await grantFreeMonthlyFloor({ workspaceId: ORG_ID, now: OCT_1 });
    expect(res.applied).toBe(true);
    expect(res.creditsAdded).toBe(0);
    expect(state.row.trialCreditsRemaining).toBe(25);
    expect(state.row.freeFloorMonth).toBe("2026-10");
    expect(floorLedgerRows()).toHaveLength(0);
  });

  test("idempotent within a month: the second call is a no-op even after spending down", async () => {
    state.row = freeRow(0, null);
    expect((await grantFreeMonthlyFloor({ workspaceId: ORG_ID, now: OCT_1 })).creditsAdded).toBe(10);
    state.row.trialCreditsRemaining = 0;
    const again = await grantFreeMonthlyFloor({ workspaceId: ORG_ID, now: new Date("2026-10-20T00:00:00.000Z") });
    expect(again).toMatchObject({ applied: false, creditsAdded: 0, reason: "already_applied" });
    expect(state.row.trialCreditsRemaining).toBe(0);
    expect(floorLedgerRows()).toHaveLength(1);
  });

  test("concurrent evaluators: only one applies", async () => {
    state.row = freeRow(0, "2026-09");
    const results = await Promise.all([
      grantFreeMonthlyFloor({ workspaceId: ORG_ID, now: OCT_1 }),
      grantFreeMonthlyFloor({ workspaceId: ORG_ID, now: OCT_1 }),
    ]);
    expect(results.map((r) => r.creditsAdded).sort()).toEqual([0, 10]);
    expect(state.row.trialCreditsRemaining).toBe(10);
    expect(floorLedgerRows()).toHaveLength(1);
  });

  test("applies again the next month", async () => {
    state.row = freeRow(0, "2026-09");
    await grantFreeMonthlyFloor({ workspaceId: ORG_ID, now: OCT_1 });
    state.row.trialCreditsRemaining = 2;
    const nov = await grantFreeMonthlyFloor({ workspaceId: ORG_ID, now: NOV_1 });
    expect(nov).toMatchObject({ applied: true, creditsAdded: 8, monthKey: `free:${ORG_ID}:2026-11` });
    expect(state.row.trialCreditsRemaining).toBe(10);
    expect(floorLedgerRows().map((l) => l.idempotencyKey)).toEqual([`free:${ORG_ID}:2026-10`, `free:${ORG_ID}:2026-11`]);
  });

  test.each(["active", "trialing"])("skipped while the subscription is %s; a downgrade gets it the month after", async (status) => {
    state.subscriptionStatus = status;
    state.row = freeRow(0, "2026-09");
    const res = await grantFreeMonthlyFloor({ workspaceId: ORG_ID, now: OCT_1 });
    expect(res).toMatchObject({ applied: false, creditsAdded: 0, reason: "pro" });
    expect(state.row.trialCreditsRemaining).toBe(0);
    expect(state.row.freeFloorMonth).toBe("2026-10");

    state.subscriptionStatus = "canceled";
    expect((await grantFreeMonthlyFloor({ workspaceId: ORG_ID, now: new Date("2026-10-15T00:00:00.000Z") })).creditsAdded).toBe(0);
    expect((await grantFreeMonthlyFloor({ workspaceId: ORG_ID, now: NOV_1 })).creditsAdded).toBe(10);
  });

  test("skipped for a team workspace", async () => {
    state.orgType = "team";
    state.row = freeRow(0, "2026-09");
    const res = await grantFreeMonthlyFloor({ workspaceId: ORG_ID, now: OCT_1 });
    expect(res).toMatchObject({ applied: false, creditsAdded: 0, reason: "team" });
    expect(state.row.trialCreditsRemaining).toBe(0);
    expect(floorLedgerRows()).toHaveLength(0);
  });

  test("no balance row: nothing is created", async () => {
    const res = await grantFreeMonthlyFloor({ workspaceId: ORG_ID, now: OCT_1 });
    expect(res.creditsAdded).toBe(0);
    expect(state.row).toBeNull();
  });
});

describe("reserve path (Mongo store)", () => {
  function reserveSummary() {
    const store = createMongooseCreditStore({ workspaceId: ORG_ID });
    return createCreditService(store).reserveCreditsOrThrow({
      workspaceId: ORG_ID,
      userId: USER_ID,
      actionType: "summary",
      qualityTier: "basic",
      idempotencyKey: `k-${Math.random()}`,
      initBalanceIfMissing: () => defaultBalanceForWorkspace(ORG_ID),
      isOnDemandEligible: async () => false,
    });
  }

  test("a drained Free workspace at the start of a new month can run a 1-credit summary", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(OCT_1);
    state.row = freeRow(0, "2026-09");

    const res = await reserveSummary();
    expect(res.creditsReserved).toBe(1);
    expect(state.row.trialCreditsRemaining).toBe(9);
    expect(state.row.freeFloorMonth).toBe("2026-10");
    expect(floorLedgerRows()).toHaveLength(1);
  });

  test("already applied this month: only the marker is compared, no plan lookups", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(OCT_1);
    state.row = freeRow(0, "2026-10");
    await expect(reserveSummary()).rejects.toThrow(/Insufficient credits/);
    expect(orgFindOne.calls).toBe(0);
  });

  test("a new personal workspace seeded with 50 is marked for this month and does not jump to 10 later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SEPT);
    await reserveSummary();
    expect(state.row?.trialCreditsRemaining).toBe(FREE_STARTER_CREDITS - 1);
    expect(state.row?.freeFloorMonth).toBe("2026-09");

    state.row!.trialCreditsRemaining = 0;
    vi.setSystemTime(new Date("2026-09-28T00:00:00.000Z"));
    await expect(reserveSummary()).rejects.toThrow(/Insufficient credits/);
    expect(state.row?.trialCreditsRemaining).toBe(0);
    expect(floorLedgerRows()).toHaveLength(0);
  });
});

describe("getCreditsSnapshot", () => {
  test("a drained personal Free workspace reports the floor and next month's reset", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SEPT);
    state.row = freeRow(0, "2026-09");
    const snap = await getCreditsSnapshot({ workspaceId: ORG_ID });
    expect(snap.includedRemaining).toBe(0);
    expect(snap.includedThisCycle).toBe(FREE_MONTHLY_FLOOR_CREDITS);
    expect(snap.resetsAt).toBe("2026-10-01T00:00:00.000Z");
    expect(snap.blocked).toBe(true);
  });

  test("first read of a new month applies the floor before computing the numbers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(OCT_1);
    state.row = freeRow(0, "2026-09");
    const snap = await getCreditsSnapshot({ workspaceId: ORG_ID });
    expect(state.row.trialCreditsRemaining).toBe(10);
    expect(snap.includedRemaining).toBe(10);
    expect(snap.includedThisCycle).toBe(10);
    expect(snap.resetsAt).toBe("2026-11-01T00:00:00.000Z");
    expect(snap.blocked).toBe(false);
  });

  test("starter credits above the floor still report 50 with no reset", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SEPT);
    state.row = freeRow(30, "2026-09");
    const snap = await getCreditsSnapshot({ workspaceId: ORG_ID });
    expect(snap.includedThisCycle).toBe(FREE_STARTER_CREDITS);
    expect(snap.resetsAt).toBeNull();
  });

  test("seeding a new row marks this month", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SEPT);
    await getCreditsSnapshot({ workspaceId: ORG_ID });
    expect(state.row?.trialCreditsRemaining).toBe(FREE_STARTER_CREDITS);
    expect(state.row?.freeFloorMonth).toBe("2026-09");
  });

  test("team and Pro: no floor, no resetsAt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(OCT_1);
    state.orgType = "team";
    state.row = freeRow(0, "2026-09");
    const team = await getCreditsSnapshot({ workspaceId: ORG_ID });
    expect(team.includedThisCycle).toBeNull();
    expect(team.resetsAt).toBeNull();
    expect(team.includedRemaining).toBe(0);

    state.orgType = "personal";
    state.subscriptionStatus = "active";
    state.row = freeRow(0, "2026-09");
    const pro = await getCreditsSnapshot({ workspaceId: ORG_ID });
    expect(pro.includedThisCycle).toBe(300);
    expect(pro.resetsAt).toBeNull();
    expect(state.row.trialCreditsRemaining).toBe(0);
  });
});
