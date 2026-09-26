import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import mongoose from "mongoose";

/**
 * The guard has to live in the Mongo update filter, not in a read-then-write around it: a settle
 * and the stale-reservation sweeper are separate calls, and a status read before the write can be
 * stale by the time the write lands.
 *
 * The defect these tests pin: the settle matched on `_id` alone and used `usageAggAppliedAt: null`
 * as its only claim. That is a different question from "is this row still pending". A row that had
 * already been refunded had never applied its aggregates, so the claim matched, the row was flipped
 * to `charged`, and its usage was billed for credits that were already back in the balance.
 *
 * The fake below is a single ledger document plus a filter matcher, so the same test exercises the
 * real decision the update makes rather than a queue of canned answers.
 */
type FakeRow = Record<string, unknown> & { _id: string };

const h = vi.hoisted(() => {
  const state = {
    row: null as FakeRow | null,
    findOneAndUpdateCalls: [] as Array<{ filter: any; update: any; options: any }>,
    updateOneCalls: [] as Array<{ filter: any; update: any }>,
    aggDailyCalls: [] as Array<{ filter: any; update: any }>,
    aggCycleCalls: [] as Array<{ filter: any; update: any }>,
  };

  /** Minimal Mongo filter matcher: exact values, `$in`, and null-means-unset. */
  const matches = (row: FakeRow, filter: Record<string, any>): boolean => {
    for (const [key, want] of Object.entries(filter)) {
      const actual = key === "_id" ? String(row._id) : (row as any)[key];
      if (key === "_id") {
        if (actual !== String(want)) return false;
        continue;
      }
      if (want && typeof want === "object" && Array.isArray(want.$in)) {
        if (!want.$in.includes(actual)) return false;
        continue;
      }
      if (want === null) {
        if (actual !== null && actual !== undefined) return false;
        continue;
      }
      if (actual !== want) return false;
    }
    return true;
  };

  const applySet = (row: FakeRow, set: Record<string, unknown> | undefined) => {
    if (!set) return;
    for (const [key, value] of Object.entries(set)) (row as any)[key] = value;
  };

  return { state, matches, applySet };
});

vi.mock("@/lib/models/CreditLedger", () => ({
  CreditLedgerModel: {
    findOneAndUpdate: vi.fn((filter: any, update: any, options: any) => {
      h.state.findOneAndUpdateCalls.push({ filter, update, options });
      const row = h.state.row;
      const hit = Boolean(row && h.matches(row, filter));
      const before = hit ? { ...(row as FakeRow) } : null;
      if (hit) h.applySet(row as FakeRow, update?.$set);
      const returned = !hit ? null : options?.new ? { ...(row as FakeRow) } : before;
      return { lean: async () => returned };
    }),
    updateOne: vi.fn(async (filter: any, update: any) => {
      h.state.updateOneCalls.push({ filter, update });
      const row = h.state.row;
      if (row && h.matches(row, filter)) h.applySet(row, update?.$set);
      return { acknowledged: true };
    }),
    findById: vi.fn(() => ({
      select: () => ({ session: () => ({ lean: async () => (h.state.row ? { ...h.state.row } : null) }) }),
    })),
  },
}));

vi.mock("@/lib/models/WorkspaceCreditBalance", () => ({ WorkspaceCreditBalanceModel: {} }));

vi.mock("@/lib/models/UsageAggDaily", () => ({
  UsageAggDailyModel: {
    updateOne: vi.fn(async (filter: any, update: any) => {
      h.state.aggDailyCalls.push({ filter, update });
      return { acknowledged: true };
    }),
  },
}));

vi.mock("@/lib/models/UsageAggCycle", () => ({
  UsageAggCycleModel: {
    updateOne: vi.fn(async (filter: any, update: any) => {
      h.state.aggCycleCalls.push({ filter, update });
      return { acknowledged: true };
    }),
  },
}));

import { createMongooseCreditStore } from "@/lib/credits/mongooseStore";

const WS = "64b000000000000000000001";
const LEDGER = "64b000000000000000000009";

/** One reserved 5-credit ai_run row, as the reserve path leaves it. */
function pendingRow(over: Partial<FakeRow> = {}): FakeRow {
  return {
    _id: LEDGER,
    eventType: "ai_run",
    status: "pending",
    creditsReserved: 5,
    creditsCharged: 0,
    usageAggAppliedAt: null,
    cycleKey: `${WS}:2026-09`,
    cycleStart: new Date("2026-09-01T00:00:00.000Z"),
    cycleEnd: new Date("2026-10-01T00:00:00.000Z"),
    creditsFromTrial: 0,
    creditsFromSubscription: 5,
    creditsFromPurchased: 0,
    creditsFromOnDemand: 0,
    costUsdActual: 0,
    createdDate: new Date("2026-09-25T10:00:00.000Z"),
    ...over,
  };
}

beforeEach(() => {
  h.state.row = null;
  h.state.findOneAndUpdateCalls = [];
  h.state.updateOneCalls = [];
  h.state.aggDailyCalls = [];
  h.state.aggCycleCalls = [];
  vi.spyOn(mongoose, "startSession").mockResolvedValue({
    withTransaction: async (fn: () => Promise<unknown>) => await fn(),
    endSession: async () => {},
  } as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Runs one status transition inside the store's own transaction wrapper. */
async function transition(args: Parameters<ReturnType<typeof createMongooseCreditStore>["setLedgerStatus"]>[0]) {
  const store = createMongooseCreditStore({ workspaceId: WS });
  return await store.withTransaction(async () => await store.setLedgerStatus(args));
}

describe("credits/mongooseStore setLedgerStatus", () => {
  test("a settle of a pending row charges it and applies its usage exactly once", async () => {
    h.state.row = pendingRow();

    const out = await transition({
      ledgerId: LEDGER,
      status: "charged",
      expectedStatus: ["pending"],
      creditsCharged: 5,
    });

    expect(h.state.row!.status).toBe("charged");
    expect(h.state.row!.creditsCharged).toBe(5);
    expect(h.state.aggDailyCalls.length).toBe(1);
    expect(h.state.aggCycleCalls.length).toBe(1);
    expect(h.state.aggDailyCalls[0]!.update.$inc).toMatchObject({
      includedUsedCredits: 5,
      totalUsedCredits: 5,
      runs: 1,
    });
    expect(h.state.row!.usageAggAppliedAt).toBeInstanceOf(Date);
    expect(out).toEqual({ moved: true, previousStatus: "pending" });
  });

  test("the guard is carried in the update filter, not checked beforehand", async () => {
    h.state.row = pendingRow();
    await transition({ ledgerId: LEDGER, status: "charged", expectedStatus: ["pending"], creditsCharged: 5 });
    expect(h.state.findOneAndUpdateCalls[0]!.filter.status).toEqual({ $in: ["pending"] });
  });

  test("a settle of a row the sweeper already refunded bills no usage and leaves it refunded", async () => {
    // The refund returned the credits and left `usageAggAppliedAt` null, which is exactly the
    // state the old aggregate claim mistook for "not yet billed".
    h.state.row = pendingRow({ status: "refunded", creditsCharged: 0, usageAggAppliedAt: null });

    const out = await transition({
      ledgerId: LEDGER,
      status: "charged",
      expectedStatus: ["pending"],
      creditsCharged: 5,
    });

    expect(h.state.aggDailyCalls).toEqual([]);
    expect(h.state.aggCycleCalls).toEqual([]);
    expect(h.state.row!.status).toBe("refunded");
    expect(h.state.row!.creditsCharged).toBe(0);
    expect(h.state.row!.usageAggAppliedAt).toBeNull();
    expect(out).toEqual({ moved: false, previousStatus: "refunded" });
  });

  test("a second settle of a charged row changes nothing", async () => {
    h.state.row = pendingRow({ status: "charged", creditsCharged: 5, usageAggAppliedAt: new Date() });

    const out = await transition({
      ledgerId: LEDGER,
      status: "charged",
      expectedStatus: ["pending"],
      creditsCharged: 999,
    });

    expect(h.state.row!.creditsCharged).toBe(5);
    expect(h.state.aggDailyCalls).toEqual([]);
    expect(out).toEqual({ moved: false, previousStatus: "charged" });
  });

  test("a refund of a pending row moves it and touches no aggregates", async () => {
    h.state.row = pendingRow();

    const out = await transition({
      ledgerId: LEDGER,
      status: "failed",
      expectedStatus: ["pending"],
      creditsCharged: 0,
    });

    expect(h.state.row!.status).toBe("failed");
    expect(h.state.aggDailyCalls).toEqual([]);
    expect(h.state.findOneAndUpdateCalls[0]!.filter.status).toEqual({ $in: ["pending"] });
    expect(out).toEqual({ moved: true, previousStatus: "pending" });
  });

  test("a refund of a row that is already charged leaves it charged", async () => {
    h.state.row = pendingRow({ status: "charged", creditsCharged: 5, usageAggAppliedAt: new Date() });

    const out = await transition({
      ledgerId: LEDGER,
      status: "failed",
      expectedStatus: ["pending"],
      creditsCharged: 0,
    });

    expect(h.state.row!.status).toBe("charged");
    expect(h.state.row!.creditsCharged).toBe(5);
    expect(out).toEqual({ moved: false, previousStatus: "charged" });
  });

  test("a row that is not an ai_run still moves but claims no aggregates", async () => {
    h.state.row = pendingRow({ eventType: "cycle_grant_included" });

    const out = await transition({
      ledgerId: LEDGER,
      status: "charged",
      expectedStatus: ["pending"],
      creditsCharged: 5,
    });

    expect(h.state.row!.status).toBe("charged");
    expect(h.state.aggDailyCalls).toEqual([]);
    expect(out).toEqual({ moved: true, previousStatus: "pending" });
  });

  test("an invalid ledger id reports no move and writes nothing", async () => {
    h.state.row = pendingRow();
    const out = await transition({ ledgerId: "not-an-id", status: "charged", expectedStatus: ["pending"] });
    expect(h.state.findOneAndUpdateCalls).toEqual([]);
    expect(h.state.updateOneCalls).toEqual([]);
    expect(out).toEqual({ moved: false, previousStatus: null });
  });

  test("without an expected status the write carries no status filter", async () => {
    h.state.row = pendingRow();
    await transition({ ledgerId: LEDGER, status: "failed" });
    expect(h.state.findOneAndUpdateCalls[0]!.filter.status).toBeUndefined();
    expect(h.state.row!.status).toBe("failed");
  });
});
