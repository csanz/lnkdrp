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
import { isProSubscription } from "@/lib/billing/subscriptionState";
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
/**
 * Cache lifetimes.
 *
 * FRESH is the real TTL: past it the entry is only good enough to answer the request that
 * triggered its refresh. STALE is the hard floor - older than that and we recompute inline rather
 * than hand back a billing page from another era.
 *
 * The two used to mean something else: any entry younger than STALE was served as-is and nothing
 * ever refreshed it, so a workspace that had just upgraded kept reading "Free", an empty included
 * balance and a hidden on-demand table for up to 30 minutes after paying.
 */
const SUMMARY_CACHE_FRESH_MS = 5 * 60_000;
const SUMMARY_CACHE_STALE_MS = 30 * 60_000;
const SUMMARY_CACHE_MAX = 50;
const summaryCache = new Map<string, SummaryCacheEntry>();
// One refresh per workspace at a time: a burst of tab switches must not fan out into N aggregates.
const summaryRefreshInflight = new Set<string>();

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

/**
 * Builds the billing summary payload for one workspace.
 *
 * Pulled out of GET so a stale cache entry can be refreshed in the background instead of being
 * served untouched until it expires; `debug` only adds the query echo to the payload.
 */
async function buildSummaryPayload(orgId: Types.ObjectId, debug: boolean): Promise<any> {
  await connectMongo();

  const [sub, bal] = await Promise.all([
    SubscriptionModel.findOne({ orgId, isDeleted: { $ne: true } })
      .select({
        status: 1,
        kind: 1,
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
  // On-demand is Pro-only: a stored toggle on a non-Pro workspace counts as off.
  const onDemandEnabled =
    isProSubscription(sub as { status?: unknown; kind?: unknown } | null) &&
    Boolean((bal as any)?.onDemandEnabled) &&
    onDemandMonthlyLimitCents > 0;

  // Derive on-demand dollars + credits used this cycle:
  // - Prefer UsageAggCycle (fast, bounded) for on-demand credits
  // - Net refunded on-demand credits out via a small ledger aggregate (refunds are rare, and
  //   the aggs are written once at charge time so they are never decremented on a refund)
  // - Fall back to the full ledger aggregate only when UsageAggCycle isn't available
  //
  // Dollars are credits x USD_CENTS_PER_CREDIT, not a stored cost. This used to net
  // `costUsdActual` (charged minus refunded) from the cycle agg and the ledger, but nothing in
  // the codebase writes that field: the ledger row is created with `costUsdActual: null` and
  // the charge path only fills provider/token telemetry, so the agg only ever gets $inc'd by 0.
  // The billing header therefore read $0.00 for a cycle Stripe had really metered. On-demand
  // has a single price, USD_CENTS_PER_CREDIT a credit, which is exactly how /api/billing/spend
  // computes the same figure for the Limits tab; the two tabs disagreed only because this one
  // asked a field that is always empty.
  let usedCentsThisCycle = 0;
  let onDemandUsedCreditsThisCycle = 0;
  let ledgerPipelineForDebug: unknown = null;
  // Read even when on-demand is off: credits used before it was turned off this cycle are still
  // reported to Stripe and invoiced, so the billing page must keep showing them.
  if (window.start && window.end) {
    const useCycleStartMatch = window.source === "subscription" || window.source === "balance";
    const aggCycleKey = `${String(orgId)}:${cycleStartIso}`;
    const aggCycle = await UsageAggCycleModel.findOne({ workspaceId: orgId, cycleKey: aggCycleKey })
      .select({ onDemandUsedCredits: 1 })
      .lean();

    const onDemandUsedFromAgg =
      typeof (aggCycle as any)?.onDemandUsedCredits === "number" ? clampNonNegInt((aggCycle as any).onDemandUsedCredits) : null;

    if (onDemandUsedFromAgg !== null) {
      const refundPipeline = [
        {
          $match: {
            workspaceId: orgId,
            eventType: "ai_run",
            status: "refunded",
            ...(useCycleStartMatch ? { cycleStart: window.start } : { createdDate: { $gte: window.start, $lt: window.end } }),
            creditsFromOnDemand: { $gt: 0 },
          },
        },
        { $group: { _id: null, refundedOnDemandCredits: { $sum: "$creditsFromOnDemand" } } },
      ] as const;
      const refundAgg = await CreditLedgerModel.aggregate(refundPipeline as any);
      const refundedOnDemandCredits = clampNonNegInt((refundAgg as any)?.[0]?.refundedOnDemandCredits ?? 0);

      // The agg counts a run the moment it is charged and is never decremented when the run is
      // refunded, so the refunded credits come off here - otherwise a refunded run would keep
      // billing the customer and keep eating their on-demand headroom for the rest of the cycle.
      onDemandUsedCreditsThisCycle = Math.max(0, onDemandUsedFromAgg - refundedOnDemandCredits);
      usedCentsThisCycle = onDemandUsedCreditsThisCycle * USD_CENTS_PER_CREDIT;
      ledgerPipelineForDebug = { source: "usageAggCycle+refundLedger", aggCycleKey, refundPipeline };
    } else {
      // Fallback: full ledger aggregate (covers environments where UsageAggCycle isn't populated yet).
      // Charged rows only: unlike the agg above, a refunded row never contributed here, so there
      // is nothing to net out.
      const ledgerPipeline = [
        {
          $match: {
            workspaceId: orgId,
            eventType: "ai_run",
            status: "charged",
            ...(useCycleStartMatch ? { cycleStart: window.start } : { createdDate: { $gte: window.start, $lt: window.end } }),
            creditsFromOnDemand: { $gt: 0 },
          },
        },
        { $group: { _id: null, onDemandChargedCredits: { $sum: "$creditsFromOnDemand" } } },
      ] as const;

      const agg = await CreditLedgerModel.aggregate(ledgerPipeline as any);
      onDemandUsedCreditsThisCycle = clampNonNegInt((agg as any)?.[0]?.onDemandChargedCredits ?? 0);
      usedCentsThisCycle = onDemandUsedCreditsThisCycle * USD_CENTS_PER_CREDIT;
      ledgerPipelineForDebug = ledgerPipeline;
    }
  }

  const includedRemaining = clampNonNegInt((bal as any)?.subscriptionCreditsRemaining ?? 0);
  const purchasedRemaining = clampNonNegInt((bal as any)?.purchasedCreditsRemaining ?? 0);
  const trialRemaining = clampNonNegInt((bal as any)?.trialCreditsRemaining ?? 0);

  // On-demand credits headroom is credits-first; compute from on-demand credits used, not invoice dollars.
  const onDemandRemainingCreditsThisCycle = onDemandEnabled
    ? Math.max(0, Math.floor(onDemandMonthlyLimitCents / USD_CENTS_PER_CREDIT) - onDemandUsedCreditsThisCycle)
    : 0;
  // Credits held. On-demand headroom is not credits (same meaning as the credits snapshot), so it
  // is reported on its own under `onDemand`.
  const creditsRemaining = includedRemaining + purchasedRemaining + trialRemaining;

  const payload = {
    cycle: { start: cycleStartIso, end: cycleEndIso, key: cycleKey },
    plan: { name: planName, status, cancelAtPeriodEnd },
    onDemand: {
      enabled: onDemandEnabled,
      monthlyLimitCents: onDemandEnabled ? onDemandMonthlyLimitCents : 0,
      usedCentsThisCycle,
      usedCreditsThisCycle: onDemandUsedCreditsThisCycle,
      remainingCreditsThisCycle: onDemandRemainingCreditsThisCycle,
    },
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

  return payload;
}

export async function GET(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActorForStats(request);
    try {
      if (actor.kind !== "user") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      if (!Types.ObjectId.isValid(actor.orgId)) return NextResponse.json({ error: "Invalid org" }, { status: 400 });
      const url = new URL(request.url);
      const debug = url.searchParams.get("debug") === "1" && debugEnabled(1);

      const orgId = new Types.ObjectId(actor.orgId);

      // Cache: billing summary is hit frequently (dashboard nav, tab switching).
      // A stale entry is served once and refreshed behind the request, the shape /api/billing/invoices
      // uses. Serving stale for the full 30 minutes without ever refreshing meant an upgrade, a new
      // credit grant or a spend-limit change stayed invisible on this tab long after the customer
      // made it.
      const cacheKey = `org:${String(orgId)}`;
      if (!debug) {
        const cached = getCachedSummary(cacheKey);
        const cachedAt = cached ? (summaryCache.get(cacheKey)?.at ?? 0) : 0;
        const cachedAge = cachedAt ? Date.now() - cachedAt : Infinity;
        const cachedFresh = cached && cachedAge <= SUMMARY_CACHE_FRESH_MS;

        if (cached) {
          if (!cachedFresh && !summaryRefreshInflight.has(cacheKey)) {
            summaryRefreshInflight.add(cacheKey);
            void (async () => {
              try {
                const fresh = await buildSummaryPayload(orgId, false);
                setCachedSummary(cacheKey, fresh);
              } catch {
                // Best-effort: keep the stale entry and let the next request try again.
              } finally {
                summaryRefreshInflight.delete(cacheKey);
              }
            })();
          }

          return NextResponse.json(cached, {
            headers: {
              "cache-control": "private, max-age=30, stale-while-revalidate=600",
              "x-lnkd-cache": cachedFresh ? "hit" : "stale",
            },
          });
        }
      }

      const payload = await buildSummaryPayload(orgId, debug);

      if (!debug) setCachedSummary(cacheKey, payload);
      return NextResponse.json(payload, {
        headers: { "cache-control": debug ? "no-store" : "private, max-age=30, stale-while-revalidate=600", "x-lnkd-cache": "miss" },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load billing summary";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
  });
}
