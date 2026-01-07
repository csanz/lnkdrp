/**
 * API route for `/api/billing/usage`.
 *
 * Returns Included Usage and On-Demand Usage tables for a selected billing cycle.
 * Customer-facing: never returns provider/model token telemetry fields.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { resolveActorForStats } from "@/lib/gating/actor";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { WorkspaceCreditBalanceModel } from "@/lib/models/WorkspaceCreditBalance";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { aggregateBillingUsage, type BillingLedgerRow } from "@/lib/billing/usageAggregation";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { debugLog } from "@/lib/debug";
import { debugEnabled } from "@/lib/debug";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UsageCacheEntry = { at: number; json: any };
// Usage tables are expensive to compute; prefer longer caching to reduce tail latency.
const USAGE_CACHE_TTL_MS = 5 * 60_000;
const USAGE_CACHE_MAX = 100;
const usageCache = new Map<string, UsageCacheEntry>();

function getCachedUsage(key: string): any | null {
  const e = usageCache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > USAGE_CACHE_TTL_MS) {
    usageCache.delete(key);
    return null;
  }
  usageCache.delete(key);
  usageCache.set(key, e);
  return e.json;
}

function setCachedUsage(key: string, json: any) {
  usageCache.set(key, { at: Date.now(), json });
  while (usageCache.size > USAGE_CACHE_MAX) {
    const oldest = usageCache.keys().next().value as string | undefined;
    if (!oldest) break;
    usageCache.delete(oldest);
  }
}

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
    const actor = await resolveActorForStats(request);
    try {
      if (actor.kind !== "user") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      if (!Types.ObjectId.isValid(actor.orgId)) return NextResponse.json({ error: "Invalid org" }, { status: 400 });
      const url = new URL(request.url);
      const debug = url.searchParams.get("debug") === "1" && debugEnabled(1);
      const cycleStartParam = url.searchParams.get("cycleStart");
      const requestedStart = parseIsoDate(cycleStartParam);
      if (!requestedStart) return NextResponse.json({ error: "Missing or invalid cycleStart" }, { status: 400 });

      await connectMongo();
      const orgId = new Types.ObjectId(actor.orgId);
      if (!debug) {
        const cached = getCachedUsage(`org:${String(orgId)}:start:${requestedStart.toISOString()}`);
        if (cached) {
          return NextResponse.json(cached, {
            headers: { "cache-control": "private, max-age=10, stale-while-revalidate=60" },
          });
        }
      }

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
      // Use the indexed `cycleStart` field when present (fast), but keep a legacy fallback
      // for any older ledger rows that didn't populate cycleStart.
      const baseMatch = {
        workspaceId: orgId,
        eventType: "ai_run",
        status: { $in: ["charged", "refunded"] as const },
      } as const;

      // Further reduce scanned docs: ignore ledger rows that can't contribute to either table.
      // (Most rows will have credits fields; this mainly protects us from odd/legacy noise.)
      const relevantOr = {
        $or: [
          { creditsFromTrial: { $gt: 0 } },
          { creditsFromSubscription: { $gt: 0 } },
          { creditsFromPurchased: { $gt: 0 } },
          { creditsFromOnDemand: { $gt: 0 } },
          { costUsdActual: { $ne: null } },
        ],
      } as const;

      const groupAndProjectStages = [
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
      ] as const;

      const pipelineFast = [{ $match: { ...baseMatch, ...relevantOr, cycleStart } }, ...groupAndProjectStages] as const;
      const pipelineLegacy = [
        { $match: { ...baseMatch, ...relevantOr, cycleStart: null, createdDate: { $gte: cycleStart, $lt: cycleEnd } } },
        ...groupAndProjectStages,
      ] as const;

      // Typical case: modern rows always have `cycleStart`, so the fast path is sufficient.
      // Only run the legacy scan when fast results are empty (older rows w/ cycleStart=null).
      const fastGrouped = await CreditLedgerModel.aggregate(pipelineFast as any);
      const legacyGrouped = Array.isArray(fastGrouped) && fastGrouped.length ? [] : await CreditLedgerModel.aggregate(pipelineLegacy as any);

      const grouped = ([] as any[]).concat(Array.isArray(fastGrouped) ? fastGrouped : [], Array.isArray(legacyGrouped) ? legacyGrouped : []) as Array<
        Partial<BillingLedgerRow>
      > as unknown as BillingLedgerRow[];

      const agg = aggregateBillingUsage({
        ledgers: Array.isArray(grouped) ? (grouped as BillingLedgerRow[]) : [],
        onDemandLimitCents: onDemandEnabled ? onDemandMonthlyLimitCents : 0,
      });

      const payload = {
        cycle: { start: cycleStart.toISOString(), end: cycleEnd.toISOString() },
        included: agg.included,
        onDemand: agg.onDemand,
        ...(debug
          ? {
              debug: {
                enabled: true,
                orgId: String(orgId),
                collection: "creditledgers",
                cycleStartIso: cycleStart.toISOString(),
                cycleEndIso: cycleEnd.toISOString(),
                pipelines: { fast: pipelineFast, legacy: pipelineLegacy },
                mongosh: [
                  "const { ObjectId } = require('mongodb');",
                  "// Fast path (preferred):",
                  "db.creditledgers.aggregate([",
                  `  { $match: { workspaceId: ObjectId("${String(orgId)}"), eventType: "ai_run", status: { $in: ["charged","refunded"] }, cycleStart: ISODate("${cycleStart.toISOString()}") } },`,
                  "  { $group: {",
                  "      _id: { actionType: \"$actionType\", qualityTier: \"$qualityTier\", modelRoute: \"$modelRoute\", status: \"$status\" },",
                  "      qty: { $sum: 1 },",
                  "      creditsCharged: { $sum: \"$creditsCharged\" },",
                  "      creditsFromTrial: { $sum: \"$creditsFromTrial\" },",
                  "      creditsFromSubscription: { $sum: \"$creditsFromSubscription\" },",
                  "      creditsFromPurchased: { $sum: \"$creditsFromPurchased\" },",
                  "      creditsFromOnDemand: { $sum: \"$creditsFromOnDemand\" },",
                  "      costUsdKnownSum: { $sum: { $cond: [ { $ne: [\"$costUsdActual\", null] }, \"$costUsdActual\", 0 ] } },",
                  "      costUsdUnknownCount: { $sum: { $cond: [ { $eq: [\"$costUsdActual\", null] }, 1, 0 ] } },",
                  "  } },",
                  "  { $project: {",
                  "      _id: 0,",
                  "      actionType: \"$_id.actionType\",",
                  "      qualityTier: \"$_id.qualityTier\",",
                  "      modelRoute: \"$_id.modelRoute\",",
                  "      status: \"$_id.status\",",
                  "      qty: 1,",
                  "      creditsCharged: 1,",
                  "      creditsFromTrial: 1,",
                  "      creditsFromSubscription: 1,",
                  "      creditsFromPurchased: 1,",
                  "      creditsFromOnDemand: 1,",
                  "      costUsdActual: { $cond: [ { $gt: [\"$costUsdUnknownCount\", 0] }, null, \"$costUsdKnownSum\" ] },",
                  "  } },",
                  "]);",
                  "",
                  "// Legacy fallback (rows with cycleStart=null):",
                  "db.creditledgers.aggregate([",
                  `  { $match: { workspaceId: ObjectId("${String(orgId)}"), eventType: "ai_run", status: { $in: ["charged","refunded"] }, cycleStart: null, createdDate: { $gte: ISODate("${cycleStart.toISOString()}"), $lt: ISODate("${cycleEnd.toISOString()}") } } },`,
                  "  { $group: {",
                  "      _id: { actionType: \"$actionType\", qualityTier: \"$qualityTier\", modelRoute: \"$modelRoute\", status: \"$status\" },",
                  "      qty: { $sum: 1 },",
                  "      creditsCharged: { $sum: \"$creditsCharged\" },",
                  "      creditsFromTrial: { $sum: \"$creditsFromTrial\" },",
                  "      creditsFromSubscription: { $sum: \"$creditsFromSubscription\" },",
                  "      creditsFromPurchased: { $sum: \"$creditsFromPurchased\" },",
                  "      creditsFromOnDemand: { $sum: \"$creditsFromOnDemand\" },",
                  "      costUsdKnownSum: { $sum: { $cond: [ { $ne: [\"$costUsdActual\", null] }, \"$costUsdActual\", 0 ] } },",
                  "      costUsdUnknownCount: { $sum: { $cond: [ { $eq: [\"$costUsdActual\", null] }, 1, 0 ] } },",
                  "  } },",
                  "  { $project: {",
                  "      _id: 0,",
                  "      actionType: \"$_id.actionType\",",
                  "      qualityTier: \"$_id.qualityTier\",",
                  "      modelRoute: \"$_id.modelRoute\",",
                  "      status: \"$_id.status\",",
                  "      qty: 1,",
                  "      creditsCharged: 1,",
                  "      creditsFromTrial: 1,",
                  "      creditsFromSubscription: 1,",
                  "      creditsFromPurchased: 1,",
                  "      creditsFromOnDemand: 1,",
                  "      costUsdActual: { $cond: [ { $gt: [\"$costUsdUnknownCount\", 0] }, null, \"$costUsdKnownSum\" ] },",
                  "  } },",
                  "]);",
                ].join("\n"),
              },
            }
          : null),
      };

      if (!debug) setCachedUsage(`org:${String(orgId)}:start:${requestedStart.toISOString()}`, payload);
      return NextResponse.json(payload, {
        headers: { "cache-control": debug ? "no-store" : "private, max-age=10, stale-while-revalidate=60" },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load billing usage";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
  });
}


