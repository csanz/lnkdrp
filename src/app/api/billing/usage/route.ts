/**
 * API route for `/api/billing/usage`.
 *
 * Returns Included Usage and On-Demand Usage tables for a selected billing cycle.
 * Customer-facing: never returns provider/model token telemetry fields.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { resolveActor } from "@/lib/gating/actor";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { WorkspaceCreditBalanceModel } from "@/lib/models/WorkspaceCreditBalance";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { aggregateBillingUsage, type BillingLedgerRow } from "@/lib/billing/usageAggregation";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { debugLog } from "@/lib/debug";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clampNonNegInt(n: unknown): number {
  const v = typeof n === "number" ? n : typeof n === "string" ? Number(n) : NaN;
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.floor(v));
}

function parseIsoDate(s: string | null): Date | null {
  const raw = (s ?? "").trim();
  if (!raw) return null;
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) return null;
  return d;
}

function last30dWindow(now = new Date()): { start: Date; end: Date } {
  const end = new Date(now);
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { start, end };
}

function resolveCycleWindow(params: {
  subStart: Date | null;
  subEnd: Date | null;
  balStart: Date | null;
  balEnd: Date | null;
}): { start: Date; end: Date; source: "subscription" | "balance" | "last30d" } {
  if (params.subStart && params.subEnd) return { start: params.subStart, end: params.subEnd, source: "subscription" };
  if (params.balStart && params.balEnd) return { start: params.balStart, end: params.balEnd, source: "balance" };
  const w = last30dWindow();
  return { start: w.start, end: w.end, source: "last30d" };
}

export async function GET(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActor(request);
    try {
      if (actor.kind !== "user") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      if (!Types.ObjectId.isValid(actor.orgId)) return NextResponse.json({ error: "Invalid org" }, { status: 400 });
      const url = new URL(request.url);
      const cycleStartParam = url.searchParams.get("cycleStart");
      const requestedStart = parseIsoDate(cycleStartParam);
      if (!requestedStart) return NextResponse.json({ error: "Missing or invalid cycleStart" }, { status: 400 });

      await connectMongo();
      const orgId = new Types.ObjectId(actor.orgId);

      // Determine a stable period length to compute cycle end.
      const [sub, bal] = await Promise.all([
        SubscriptionModel.findOne({ orgId, isDeleted: { $ne: true } })
          .select({ currentPeriodStart: 1, currentPeriodEnd: 1 })
          .lean(),
        WorkspaceCreditBalanceModel.findOne({ workspaceId: orgId })
          .select({ currentPeriodStart: 1, currentPeriodEnd: 1, onDemandEnabled: 1, onDemandMonthlyLimitCents: 1 })
          .lean(),
      ]);

      const subStart = (sub as any)?.currentPeriodStart instanceof Date ? (sub as any).currentPeriodStart : null;
      const subEnd = (sub as any)?.currentPeriodEnd instanceof Date ? (sub as any).currentPeriodEnd : null;
      const balStart = (bal as any)?.currentPeriodStart instanceof Date ? (bal as any).currentPeriodStart : null;
      const balEnd = (bal as any)?.currentPeriodEnd instanceof Date ? (bal as any).currentPeriodEnd : null;

      const current = resolveCycleWindow({ subStart, subEnd, balStart, balEnd });
      debugLog(1, "[billing:usage] cycle window", { source: current.source, start: current.start.toISOString(), end: current.end.toISOString() });
      const periodMs = Math.max(1, current.end.getTime() - current.start.getTime());

      const cycleStart = new Date(requestedStart);
      const cycleEnd = new Date(cycleStart.getTime() + periodMs);

      const onDemandMonthlyLimitCents = clampNonNegInt((bal as any)?.onDemandMonthlyLimitCents ?? 0);
      const onDemandEnabled = Boolean((bal as any)?.onDemandEnabled) && onDemandMonthlyLimitCents > 0;

      // Speed: aggregate in MongoDB instead of fetching all per-run ledger rows.
      // This keeps response time stable even when a workspace has many runs in a cycle.
      const grouped = (await CreditLedgerModel.aggregate([
        {
          $match: {
            workspaceId: orgId,
            eventType: "ai_run",
            status: { $in: ["charged", "refunded"] },
            createdDate: { $gte: cycleStart, $lt: cycleEnd },
          },
        },
        {
          $group: {
            _id: {
              actionType: "$actionType",
              qualityTier: "$qualityTier",
              modelRoute: "$modelRoute",
              status: "$status",
            },
            qty: { $sum: 1 },
            creditsCharged: { $sum: "$creditsCharged" },
            creditsFromTrial: { $sum: "$creditsFromTrial" },
            creditsFromSubscription: { $sum: "$creditsFromSubscription" },
            creditsFromPurchased: { $sum: "$creditsFromPurchased" },
            creditsFromOnDemand: { $sum: "$creditsFromOnDemand" },
            costUsdKnownSum: {
              $sum: {
                $cond: [{ $ne: ["$costUsdActual", null] }, "$costUsdActual", 0],
              },
            },
            costUsdUnknownCount: {
              $sum: {
                $cond: [{ $eq: ["$costUsdActual", null] }, 1, 0],
              },
            },
          },
        },
        {
          $project: {
            _id: 0,
            actionType: "$_id.actionType",
            qualityTier: "$_id.qualityTier",
            modelRoute: "$_id.modelRoute",
            status: "$_id.status",
            qty: 1,
            creditsCharged: 1,
            creditsFromTrial: 1,
            creditsFromSubscription: 1,
            creditsFromPurchased: 1,
            creditsFromOnDemand: 1,
            // Preserve existing semantics: if any ledger row in this bucket has unknown cost,
            // treat the whole bucket as unknown (the UI shows "Not available").
            costUsdActual: {
              $cond: [{ $gt: ["$costUsdUnknownCount", 0] }, null, "$costUsdKnownSum"],
            },
          },
        },
      ])) as Array<Partial<BillingLedgerRow>> as unknown as BillingLedgerRow[];

      const agg = aggregateBillingUsage({
        ledgers: Array.isArray(grouped) ? (grouped as BillingLedgerRow[]) : [],
        onDemandLimitCents: onDemandEnabled ? onDemandMonthlyLimitCents : 0,
      });

      return NextResponse.json(
        {
          cycle: { start: cycleStart.toISOString(), end: cycleEnd.toISOString() },
          included: agg.included,
          onDemand: agg.onDemand,
        },
        { headers: { "cache-control": "no-store" } },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load billing usage";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
  });
}


