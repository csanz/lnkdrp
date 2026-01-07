/**
 * API route for `/api/billing/summary`.
 *
 * Org-scoped summary used to render Billing & Invoices header and cycle selector.
 * Customer-facing: never returns provider/model token telemetry fields.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { resolveActorForStats } from "@/lib/gating/actor";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { WorkspaceCreditBalanceModel } from "@/lib/models/WorkspaceCreditBalance";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { UsageAggCycleModel } from "@/lib/models/UsageAggCycle";
import { USD_CENTS_PER_CREDIT } from "@/lib/billing/pricing";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { debugLog } from "@/lib/debug";
import { debugEnabled } from "@/lib/debug";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SummaryCacheEntry = { at: number; json: any };
// Summary values can tolerate slight staleness; prefer consistency and low tail latency.
const SUMMARY_CACHE_FRESH_MS = 5 * 60_000;
const SUMMARY_CACHE_STALE_MS = 30 * 60_000;
const SUMMARY_CACHE_MAX = 50;
const summaryCache = new Map<string, SummaryCacheEntry>();

function getCachedSummary(key: string): any | null {
  const e = summaryCache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > SUMMARY_CACHE_STALE_MS) {
    summaryCache.delete(key);
    return null;
  }
  // Refresh recency
  summaryCache.delete(key);
  summaryCache.set(key, e);
  return e.json;
}

function setCachedSummary(key: string, json: any) {
  summaryCache.set(key, { at: Date.now(), json });
  while (summaryCache.size > SUMMARY_CACHE_MAX) {
    const oldest = summaryCache.keys().next().value as string | undefined;
    if (!oldest) break;
    summaryCache.delete(oldest);
  }
}

function clampNonNegInt(n: unknown): number {
  const v = typeof n === "number" ? n : typeof n === "string" ? Number(n) : NaN;
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.floor(v));
}

function safeIso(d: unknown): string | null {
  if (!(d instanceof Date)) return null;
  const t = d.getTime();
  if (!Number.isFinite(t)) return null;
  return d.toISOString();
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

      await connectMongo();
      const orgId = new Types.ObjectId(actor.orgId);

      // Cache: billing summary is hit frequently (dashboard nav, tab switching).
      // Keep it short-lived; billing state doesn't require per-request precision.
      if (!debug) {
        const cacheKey = `org:${String(orgId)}`;
        const cached = getCachedSummary(cacheKey);
        const cachedAt = cached ? (summaryCache.get(cacheKey)?.at ?? 0) : 0;
        const cachedAge = cachedAt ? Date.now() - cachedAt : Infinity;
        const cachedFresh = cached && cachedAge <= SUMMARY_CACHE_FRESH_MS;

        if (cached) {
          return NextResponse.json(cached, {
            headers: {
              "cache-control": "private, max-age=30, stale-while-revalidate=600",
              "x-lnkd-cache": cachedFresh ? "hit" : "stale",
            },
          });
        }
      }

      const [sub, bal] = await Promise.all([
        SubscriptionModel.findOne({ orgId, isDeleted: { $ne: true } })
          .select({
            status: 1,
            planName: 1,
            cancelAtPeriodEnd: 1,
            stripeCustomerId: 1,
            stripeSubscriptionId: 1,
            currentPeriodStart: 1,
            currentPeriodEnd: 1,
          })
          .lean(),
        WorkspaceCreditBalanceModel.findOne({ workspaceId: orgId })
          .select({
            trialCreditsRemaining: 1,
            subscriptionCreditsRemaining: 1,
            purchasedCreditsRemaining: 1,
            onDemandEnabled: 1,
            onDemandMonthlyLimitCents: 1,
            currentPeriodStart: 1,
            currentPeriodEnd: 1,
          })
          .lean(),
      ]);

      const subStart = (sub as any)?.currentPeriodStart instanceof Date ? (sub as any).currentPeriodStart : null;
      const subEnd = (sub as any)?.currentPeriodEnd instanceof Date ? (sub as any).currentPeriodEnd : null;
      const balStart = (bal as any)?.currentPeriodStart instanceof Date ? (bal as any).currentPeriodStart : null;
      const balEnd = (bal as any)?.currentPeriodEnd instanceof Date ? (bal as any).currentPeriodEnd : null;

      const window = resolveCycleWindow({ subStart, subEnd, balStart, balEnd });
      debugLog(1, "[billing:summary] cycle window", { source: window.source, start: window.start.toISOString(), end: window.end.toISOString() });
      const cycleStartIso = safeIso(window.start) ?? new Date(window.start).toISOString();
      const cycleEndIso = safeIso(window.end) ?? new Date(window.end).toISOString();

      const stripeSubscriptionId =
        typeof (sub as any)?.stripeSubscriptionId === "string" ? String((sub as any).stripeSubscriptionId).trim() : "";
      const cycleKey = stripeSubscriptionId ? `${stripeSubscriptionId}:${cycleStartIso}` : `cycle:${cycleStartIso}`;

      const planName = (typeof (sub as any)?.planName === "string" ? String((sub as any).planName).trim() : "") || "Free";
      const status = (typeof (sub as any)?.status === "string" ? String((sub as any).status).trim() : "") || "free";
      const cancelAtPeriodEnd = Boolean((sub as any)?.cancelAtPeriodEnd);

      const onDemandMonthlyLimitCents = clampNonNegInt((bal as any)?.onDemandMonthlyLimitCents ?? 0);
      const onDemandEnabled = Boolean((bal as any)?.onDemandEnabled) && onDemandMonthlyLimitCents > 0;

      // Derive on-demand dollars + credits used this cycle:
      // - Prefer UsageAggCycle (fast, bounded) for charged totals and on-demand credits
      // - Compute refunds via a small ledger aggregate (refunds are rare and not tracked in the aggs)
      // - Fall back to the full ledger aggregate only when UsageAggCycle isn't available
      let usedCentsThisCycle = 0;
      let onDemandUsedCreditsThisCycle = 0;
      let ledgerPipelineForDebug: unknown = null;
      // If on-demand is disabled, the UI doesn't use `usedCentsThisCycle` and we can avoid all ledger/agg reads.
      if (onDemandEnabled && window.start && window.end) {
        const useCycleStartMatch = window.source === "subscription" || window.source === "balance";
        const aggCycleKey = `${String(orgId)}:${cycleStartIso}`;
        const aggCycle = await UsageAggCycleModel.findOne({ workspaceId: orgId, cycleKey: aggCycleKey })
          .select({ costUsdActual: 1, onDemandUsedCredits: 1 })
          .lean();

        const chargedUsdFromAgg = typeof (aggCycle as any)?.costUsdActual === "number" ? (aggCycle as any).costUsdActual : null;
        const onDemandUsedFromAgg =
          typeof (aggCycle as any)?.onDemandUsedCredits === "number" ? clampNonNegInt((aggCycle as any).onDemandUsedCredits) : null;

        if (chargedUsdFromAgg !== null && onDemandUsedFromAgg !== null) {
          const refundPipeline = [
            {
              $match: {
                workspaceId: orgId,
                eventType: "ai_run",
                status: "refunded",
                ...(useCycleStartMatch ? { cycleStart: window.start } : { createdDate: { $gte: window.start, $lt: window.end } }),
                costUsdActual: { $ne: null },
              },
            },
            { $group: { _id: null, refundedUsd: { $sum: "$costUsdActual" } } },
          ] as const;
          const refundAgg = await CreditLedgerModel.aggregate(refundPipeline as any);
          const refundedUsd = typeof (refundAgg as any)?.[0]?.refundedUsd === "number" ? (refundAgg as any)[0].refundedUsd : 0;

          const usdNet = Math.max(0, chargedUsdFromAgg - refundedUsd);
          usedCentsThisCycle = Math.max(0, Math.round(usdNet * 100));
          onDemandUsedCreditsThisCycle = onDemandUsedFromAgg;
          ledgerPipelineForDebug = { source: "usageAggCycle+refundLedger", aggCycleKey, refundPipeline };
        } else {
          // Fallback: full ledger aggregate (covers environments where UsageAggCycle isn't populated yet).
          const ledgerPipeline = [
            {
              $match: {
                workspaceId: orgId,
                eventType: "ai_run",
                status: { $in: ["charged", "refunded"] },
                ...(useCycleStartMatch ? { cycleStart: window.start } : { createdDate: { $gte: window.start, $lt: window.end } }),
                // Only count Stripe-backed dollars when available; do not fabricate costs.
                // Also include on-demand credits to compute remaining headroom.
                $or: [{ costUsdActual: { $ne: null } }, { creditsFromOnDemand: { $gt: 0 } }],
              },
            },
            {
              $group: {
                _id: null,
                chargedUsd: {
                  $sum: {
                    $cond: [
                      { $and: [{ $eq: ["$status", "charged"] }, { $ne: ["$costUsdActual", null] }] },
                      "$costUsdActual",
                      0,
                    ],
                  },
                },
                refundedUsd: {
                  $sum: {
                    $cond: [
                      { $and: [{ $eq: ["$status", "refunded"] }, { $ne: ["$costUsdActual", null] }] },
                      "$costUsdActual",
                      0,
                    ],
                  },
                },
                onDemandChargedCredits: {
                  $sum: {
                    $cond: [
                      { $and: [{ $eq: ["$status", "charged"] }, { $gt: ["$creditsFromOnDemand", 0] }] },
                      "$creditsFromOnDemand",
                      0,
                    ],
                  },
                },
              },
            },
          ] as const;

          const agg = await CreditLedgerModel.aggregate(ledgerPipeline as any);
          const chargedUsd = typeof (agg as any)?.[0]?.chargedUsd === "number" ? (agg as any)[0].chargedUsd : 0;
          const refundedUsd2 = typeof (agg as any)?.[0]?.refundedUsd === "number" ? (agg as any)[0].refundedUsd : 0;
          const usdNet = Math.max(0, chargedUsd - refundedUsd2);
          usedCentsThisCycle = Math.max(0, Math.round(usdNet * 100));
          onDemandUsedCreditsThisCycle = clampNonNegInt((agg as any)?.[0]?.onDemandChargedCredits ?? 0);
          ledgerPipelineForDebug = ledgerPipeline;
        }
      }

      const includedRemaining = clampNonNegInt((bal as any)?.subscriptionCreditsRemaining ?? 0);
      const purchasedRemaining = clampNonNegInt((bal as any)?.purchasedCreditsRemaining ?? 0);
      const trialRemaining = clampNonNegInt((bal as any)?.trialCreditsRemaining ?? 0);

      // On-demand credits headroom is credits-first; compute from on-demand credits used, not invoice dollars.
      if (!onDemandEnabled) onDemandUsedCreditsThisCycle = 0;

      const onDemandRemainingCreditsThisCycle = onDemandEnabled
        ? Math.max(0, Math.floor(onDemandMonthlyLimitCents / USD_CENTS_PER_CREDIT) - onDemandUsedCreditsThisCycle)
        : 0;
      const creditsRemaining = includedRemaining + purchasedRemaining + trialRemaining + onDemandRemainingCreditsThisCycle;

      const payload = {
        cycle: { start: cycleStartIso, end: cycleEndIso, key: cycleKey },
        plan: { name: planName, status, cancelAtPeriodEnd },
        onDemand: { enabled: onDemandEnabled, monthlyLimitCents: onDemandEnabled ? onDemandMonthlyLimitCents : 0, usedCentsThisCycle },
        balances: { includedRemaining, purchasedRemaining, trialRemaining, creditsRemaining },
        ...(debug
          ? {
              debug: {
                enabled: true,
                orgId: String(orgId),
                subscriptionQuery: {
                  collection: "subscriptions",
                  filter: { orgId: String(orgId), isDeleted: { $ne: true } },
                  projection: {
                    status: 1,
                    planName: 1,
                    cancelAtPeriodEnd: 1,
                    currentPeriodStart: 1,
                    currentPeriodEnd: 1,
                  },
                },
                balanceQuery: {
                  collection: "workspacecreditbalances",
                  filter: { workspaceId: String(orgId) },
                  projection: {
                    trialCreditsRemaining: 1,
                    subscriptionCreditsRemaining: 1,
                    purchasedCreditsRemaining: 1,
                    onDemandEnabled: 1,
                    onDemandMonthlyLimitCents: 1,
                    currentPeriodStart: 1,
                    currentPeriodEnd: 1,
                  },
                },
                ledgerAggregate: {
                  collection: "creditledgers",
                  windowStartIso: cycleStartIso,
                  windowEndIso: cycleEndIso,
                  pipeline: ledgerPipelineForDebug,
                },
              },
            }
          : null),
      };

      if (!debug) setCachedSummary(`org:${String(orgId)}`, payload);
      return NextResponse.json(payload, {
        headers: { "cache-control": debug ? "no-store" : "private, max-age=30, stale-while-revalidate=600", "x-lnkd-cache": "miss" },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load billing summary";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
  });
}


