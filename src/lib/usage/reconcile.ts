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

  // Cycle aggregates (only where cycleKey exists).
  const cycleAgg = (await CreditLedgerModel.aggregate([
    { $match: { ...matchBase, cycleKey: { $type: "string" } } },
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


