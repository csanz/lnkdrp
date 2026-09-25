/**
 * Usage reconcile recomputes whole billing cycles, never a window's slice of one (code review
 * 2026-09-23, H6).
 *
 * The ledger is mocked at the aggregate call, which is where the bug lived: the cycle aggregate
 * carried the window's `createdDate` bound and wrote its partial sum over the cycle total with
 * `$set`. The test drives the module with a one-day window over a cycle that started earlier and
 * checks that the rows summed for the cycle are the cycle's, not the day's.
 */
import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectMongo: vi.fn(async () => undefined),
  ledgerAggregate: vi.fn(),
  dailyBulkWrite: vi.fn(async () => undefined),
  cycleBulkWrite: vi.fn(async () => undefined),
}));

vi.mock("@/lib/mongodb", () => ({ connectMongo: mocks.connectMongo }));
vi.mock("@/lib/models/CreditLedger", () => ({ CreditLedgerModel: { aggregate: mocks.ledgerAggregate } }));
vi.mock("@/lib/models/UsageAggDaily", () => ({ UsageAggDailyModel: { bulkWrite: mocks.dailyBulkWrite } }));
vi.mock("@/lib/models/UsageAggCycle", () => ({ UsageAggCycleModel: { bulkWrite: mocks.cycleBulkWrite } }));

import { cycleRowsMatch, reconcileUsageAggsFromLedger } from "@/lib/usage/reconcile";

const WORKSPACE = new Types.ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa");
const CYCLE = "2026-09-01_2026-10-01";

/** Pull the `$match` stage out of an aggregate pipeline. */
function matchOf(pipeline: unknown): Record<string, unknown> {
  const stages = pipeline as Array<Record<string, unknown>>;
  return (stages[0]?.$match ?? {}) as Record<string, unknown>;
}

describe("cycleRowsMatch", () => {
  it("matches every charged run of the named cycles with no date bound", () => {
    const m = cycleRowsMatch([{ workspaceId: WORKSPACE, cycleKey: CYCLE }]);
    expect(m).toEqual({
      status: "charged",
      eventType: "ai_run",
      $or: [{ workspaceId: WORKSPACE, cycleKey: CYCLE }],
    });
    expect(m).not.toHaveProperty("createdDate");
  });

  it("matches nothing when no cycle was touched, without an empty $or", () => {
    const m = cycleRowsMatch([]);
    expect(m).not.toHaveProperty("$or");
    expect(m).toEqual({ _id: { $in: [] } });
  });
});

describe("reconcileUsageAggsFromLedger", () => {
  beforeEach(() => {
    mocks.ledgerAggregate.mockReset();
    mocks.dailyBulkWrite.mockClear();
    mocks.cycleBulkWrite.mockClear();
  });

  it("sums a cycle over all its rows when the window covers only one day of it", async () => {
    const seen: unknown[] = [];
    mocks.ledgerAggregate.mockImplementation(async (pipeline: unknown) => {
      seen.push(pipeline);
      const m = matchOf(pipeline);
      const stages = pipeline as Array<Record<string, unknown>>;
      const group = stages[1]?.$group as Record<string, unknown> | undefined;
      // 1. daily aggregate: bounded by the window.
      if (m.createdDate && group && "runs" in group) {
        return [
          {
            _id: { workspaceId: WORKSPACE, day: "2026-09-22" },
            includedUsedCredits: 2,
            paidUsedCredits: 0,
            totalUsedCredits: 2,
            onDemandUsedCredits: 0,
            costUsdActual: 0.01,
            runs: 1,
          },
        ];
      }
      // 2. which cycles have a row inside the window.
      if (m.createdDate && group && !("runs" in group)) {
        return [{ _id: { workspaceId: WORKSPACE, cycleKey: CYCLE } }];
      }
      // 3. the cycle's whole row set: 40 credits over the month, not the day's 2.
      if (!m.createdDate && Array.isArray(m.$or)) {
        return [
          {
            _id: { workspaceId: WORKSPACE, cycleKey: CYCLE },
            cycleStart: new Date("2026-09-01T00:00:00Z"),
            cycleEnd: new Date("2026-10-01T00:00:00Z"),
            includedUsedCredits: 40,
            paidUsedCredits: 0,
            totalUsedCredits: 40,
            onDemandUsedCredits: 0,
            costUsdActual: 0.2,
            runs: 20,
          },
        ];
      }
      throw new Error(`unexpected pipeline: ${JSON.stringify(pipeline)}`);
    });

    const res = await reconcileUsageAggsFromLedger({
      startDay: new Date("2026-09-22T00:00:00Z"),
      endDayExclusive: new Date("2026-09-23T00:00:00Z"),
    });

    expect(res.cycleRows).toBe(1);
    expect(seen).toHaveLength(3);
    // The cycle sum was asked for without the window's date bound.
    const cycleMatch = matchOf(seen[2]);
    expect(cycleMatch).not.toHaveProperty("createdDate");
    expect(cycleMatch.$or).toEqual([{ workspaceId: WORKSPACE, cycleKey: CYCLE }]);

    // And the cycle row written is the whole cycle's total.
    const ops = (mocks.cycleBulkWrite.mock.calls as unknown[][])[0]?.[0] as Array<{
      updateOne: { filter: Record<string, unknown>; update: { $set: Record<string, unknown> } };
    }>;
    expect(ops).toHaveLength(1);
    expect(ops[0].updateOne.filter).toEqual({ workspaceId: WORKSPACE, cycleKey: CYCLE });
    expect(ops[0].updateOne.update.$set.totalUsedCredits).toBe(40);
    expect(ops[0].updateOne.update.$set.runs).toBe(20);
  });

  it("touches no cycle row when the window has no charged run", async () => {
    mocks.ledgerAggregate.mockImplementation(async (pipeline: unknown) => {
      const m = matchOf(pipeline);
      if (!m.createdDate) {
        // The impossible filter: nothing to sum.
        expect(m).toEqual({ _id: { $in: [] } });
      }
      return [];
    });
    const res = await reconcileUsageAggsFromLedger({
      startDay: new Date("2026-09-22T00:00:00Z"),
      endDayExclusive: new Date("2026-09-23T00:00:00Z"),
    });
    expect(res.cycleRows).toBe(0);
    expect(mocks.cycleBulkWrite).not.toHaveBeenCalled();
    expect(mocks.dailyBulkWrite).not.toHaveBeenCalled();
  });
});
