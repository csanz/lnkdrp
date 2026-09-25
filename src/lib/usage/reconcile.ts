import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { UsageAggDailyModel } from "@/lib/models/UsageAggDaily";
import { UsageAggCycleModel } from "@/lib/models/UsageAggCycle";

function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

/**
 * Match every charged AI run belonging to one of `cycles`, with no date bound: each pair is a
 * whole billing cycle of one workspace. An empty list matches nothing (`$or: []` is an error in
 * Mongo, so it is spelled as an impossible filter instead).
 */
export function cycleRowsMatch(
  cycles: ReadonlyArray<{ workspaceId: Types.ObjectId; cycleKey: string }>,
): Record<string, unknown> {
  if (cycles.length === 0) return { _id: { $in: [] } };
  return {
    status: "charged",
    eventType: "ai_run",
    $or: cycles.map((c) => ({ workspaceId: c.workspaceId, cycleKey: c.cycleKey })),
  };
}

export type ReconcileUsageAggsResult = {
  ok: true;
  range: { startDay: string; endDayExclusive: string };
  workspaces: number;
  dailyRows: number;
  cycleRows: number;
};

/**
 * Recompute usage aggregates derived from `CreditLedger` for a given UTC day range.
 *
 * Idempotent: writes deterministic totals via upserts (no `$inc` drift).
 */
export async function reconcileUsageAggsFromLedger(params: {
  startDay: Date;
  /** Exclusive end day. */
  endDayExclusive: Date;
  workspaceId?: string | null;
}): Promise<ReconcileUsageAggsResult> {
  const startDay = startOfUtcDay(params.startDay);
  const endDayExclusive = startOfUtcDay(params.endDayExclusive);
  if (!(startDay.getTime() < endDayExclusive.getTime())) throw new Error("Invalid date range");

  const workspaceId = (params.workspaceId ?? "").trim();
  if (workspaceId && !Types.ObjectId.isValid(workspaceId)) throw new Error("Invalid workspaceId");
  const workspaceObjectId = workspaceId ? new Types.ObjectId(workspaceId) : null;

  await connectMongo();

  const matchBase: Record<string, unknown> = {
    status: "charged",
    eventType: "ai_run",
    createdDate: { $gte: startDay, $lt: endDayExclusive },
  };
  if (workspaceObjectId) matchBase.workspaceId = workspaceObjectId;

  // Daily aggregates.
  const dailyAgg = (await CreditLedgerModel.aggregate([
    { $match: matchBase },
    {
      $group: {
        _id: {
          workspaceId: "$workspaceId",
          day: { $dateToString: { date: "$createdDate", format: "%Y-%m-%d", timezone: "UTC" } },
        },
        includedUsedCredits: { $sum: { $add: ["$creditsFromTrial", "$creditsFromSubscription"] } },
        paidUsedCredits: { $sum: { $add: ["$creditsFromPurchased", "$creditsFromOnDemand"] } },
        totalUsedCredits: { $sum: "$creditsCharged" },
        onDemandUsedCredits: { $sum: "$creditsFromOnDemand" },
        costUsdActual: { $sum: { $ifNull: ["$costUsdActual", 0] } },
        runs: { $sum: 1 },
      },
    },
  ])) as Array<{
    _id: { workspaceId: Types.ObjectId; day: string };
    includedUsedCredits: number;
    paidUsedCredits: number;
    totalUsedCredits: number;
    onDemandUsedCredits: number;
    costUsdActual: number;
    runs: number;
  }>;

  /**
   * Cycle aggregates: every cycle that has a charged row inside the window, recomputed over the
   * cycle's whole row set.
   *
   * The window bounds which cycles are touched, not which rows are summed. A cycle is a billing
   * period, not a day range, and one that starts before the window (or the default 45 days) has
   * rows the window does not cover. Summing only the in-window rows and writing the result with
   * `$set` replaced the cycle total with a partial sum: `?start=X&end=X` turned every current
   * cycle's `totalUsedCredits` into one day's spend, and the credits snapshot, the billing summary
   * and the on-demand spend cap all read that figure until the next hourly run put it back.
   */
  const cyclesInWindow = (await CreditLedgerModel.aggregate([
    { $match: { ...matchBase, cycleKey: { $type: "string" } } },
    { $group: { _id: { workspaceId: "$workspaceId", cycleKey: "$cycleKey" } } },
  ])) as Array<{ _id: { workspaceId: Types.ObjectId; cycleKey: string } }>;

  const cycleAgg = (await CreditLedgerModel.aggregate([
    { $match: cycleRowsMatch(cyclesInWindow.map((c) => c._id)) },
    {
      $group: {
        _id: { workspaceId: "$workspaceId", cycleKey: "$cycleKey" },
        cycleStart: { $min: "$cycleStart" },
        cycleEnd: { $max: "$cycleEnd" },
        includedUsedCredits: { $sum: { $add: ["$creditsFromTrial", "$creditsFromSubscription"] } },
        paidUsedCredits: { $sum: { $add: ["$creditsFromPurchased", "$creditsFromOnDemand"] } },
        totalUsedCredits: { $sum: "$creditsCharged" },
        onDemandUsedCredits: { $sum: "$creditsFromOnDemand" },
        costUsdActual: { $sum: { $ifNull: ["$costUsdActual", 0] } },
        runs: { $sum: 1 },
      },
    },
  ])) as Array<{
    _id: { workspaceId: Types.ObjectId; cycleKey: string };
    cycleStart: Date | null;
    cycleEnd: Date | null;
    includedUsedCredits: number;
    paidUsedCredits: number;
    totalUsedCredits: number;
    onDemandUsedCredits: number;
    costUsdActual: number;
    runs: number;
  }>;

  // Write deterministic totals (upsert + $set).
  if (dailyAgg.length) {
    await UsageAggDailyModel.bulkWrite(
      dailyAgg.map((r) => ({
        updateOne: {
          filter: { workspaceId: r._id.workspaceId, day: r._id.day },
          update: {
            $setOnInsert: { workspaceId: r._id.workspaceId, day: r._id.day },
            $set: {
              includedUsedCredits: Math.max(0, Math.floor(r.includedUsedCredits ?? 0)),
              paidUsedCredits: Math.max(0, Math.floor(r.paidUsedCredits ?? 0)),
              totalUsedCredits: Math.max(0, Math.floor(r.totalUsedCredits ?? 0)),
              onDemandUsedCredits: Math.max(0, Math.floor(r.onDemandUsedCredits ?? 0)),
              costUsdActual: typeof r.costUsdActual === "number" && Number.isFinite(r.costUsdActual) ? Math.max(0, r.costUsdActual) : 0,
              runs: Math.max(0, Math.floor(r.runs ?? 0)),
            },
          },
          upsert: true,
        },
      })) as any,
      { ordered: false },
    );
  }

  if (cycleAgg.length) {
    await UsageAggCycleModel.bulkWrite(
      cycleAgg.map((r) => ({
        updateOne: {
          filter: { workspaceId: r._id.workspaceId, cycleKey: r._id.cycleKey },
          update: {
            $setOnInsert: { workspaceId: r._id.workspaceId, cycleKey: r._id.cycleKey },
            $set: {
              cycleStart: r.cycleStart ?? null,
              cycleEnd: r.cycleEnd ?? null,
              includedUsedCredits: Math.max(0, Math.floor(r.includedUsedCredits ?? 0)),
              paidUsedCredits: Math.max(0, Math.floor(r.paidUsedCredits ?? 0)),
              totalUsedCredits: Math.max(0, Math.floor(r.totalUsedCredits ?? 0)),
              onDemandUsedCredits: Math.max(0, Math.floor(r.onDemandUsedCredits ?? 0)),
              costUsdActual: typeof r.costUsdActual === "number" && Number.isFinite(r.costUsdActual) ? Math.max(0, r.costUsdActual) : 0,
              runs: Math.max(0, Math.floor(r.runs ?? 0)),
            },
          },
          upsert: true,
        },
      })) as any,
      { ordered: false },
    );
  }

  const workspaces = new Set<string>();
  for (const r of dailyAgg) workspaces.add(String(r._id.workspaceId));
  for (const r of cycleAgg) workspaces.add(String(r._id.workspaceId));

  return {
    ok: true,
    range: { startDay: utcDayKey(startDay), endDayExclusive: utcDayKey(endDayExclusive) },
    workspaces: workspaces.size,
    dailyRows: dailyAgg.length,
    cycleRows: cycleAgg.length,
  };
}


