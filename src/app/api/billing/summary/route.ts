/**
 * API route for `/api/billing/summary`.
 *
 * Org-scoped summary used to render Billing & Invoices header and cycle selector.
 * Customer-facing: never returns provider/model token telemetry fields.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { resolveActor } from "@/lib/gating/actor";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { WorkspaceCreditBalanceModel } from "@/lib/models/WorkspaceCreditBalance";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { USD_CENTS_PER_CREDIT } from "@/lib/billing/pricing";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { debugLog } from "@/lib/debug";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    const actor = await resolveActor(request);
    try {
      if (actor.kind !== "user") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      if (!Types.ObjectId.isValid(actor.orgId)) return NextResponse.json({ error: "Invalid org" }, { status: 400 });

      await connectMongo();
      const orgId = new Types.ObjectId(actor.orgId);

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

      // Derive on-demand dollars used this cycle from ledger.
      let usedCentsThisCycle = 0;
      if (window.start && window.end) {
        const agg = await CreditLedgerModel.aggregate([
          {
            $match: {
              workspaceId: orgId,
              eventType: "ai_run",
              status: { $in: ["charged", "refunded"] },
              createdDate: { $gte: window.start, $lt: window.end },
              // Only count Stripe-backed dollars when available; do not fabricate costs.
              costUsdActual: { $ne: null },
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
            },
          },
        ]);

        const chargedUsd = typeof (agg as any)?.[0]?.chargedUsd === "number" ? (agg as any)[0].chargedUsd : 0;
        const refundedUsd = typeof (agg as any)?.[0]?.refundedUsd === "number" ? (agg as any)[0].refundedUsd : 0;

        const usdNet = Math.max(0, chargedUsd - refundedUsd);
        usedCentsThisCycle = Math.max(0, Math.round(usdNet * 100));
      }

      const includedRemaining = clampNonNegInt((bal as any)?.subscriptionCreditsRemaining ?? 0);
      const purchasedRemaining = clampNonNegInt((bal as any)?.purchasedCreditsRemaining ?? 0);
      const trialRemaining = clampNonNegInt((bal as any)?.trialCreditsRemaining ?? 0);

      // On-demand credits headroom is credits-first; compute from on-demand credits used, not invoice dollars.
      let onDemandUsedCreditsThisCycle = 0;
      if (onDemandEnabled && window.start && window.end) {
        const agg = await CreditLedgerModel.aggregate([
          {
            $match: {
              workspaceId: orgId,
              eventType: "ai_run",
              status: "charged",
              createdDate: { $gte: window.start, $lt: window.end },
              creditsFromOnDemand: { $gt: 0 },
            },
          },
          { $group: { _id: null, sum: { $sum: "$creditsFromOnDemand" } } },
        ]);
        onDemandUsedCreditsThisCycle = clampNonNegInt((agg as any)?.[0]?.sum ?? 0);
      }

      const onDemandRemainingCreditsThisCycle = onDemandEnabled
        ? Math.max(0, Math.floor(onDemandMonthlyLimitCents / USD_CENTS_PER_CREDIT) - onDemandUsedCreditsThisCycle)
        : 0;
      const creditsRemaining = includedRemaining + purchasedRemaining + trialRemaining + onDemandRemainingCreditsThisCycle;

      return NextResponse.json(
        {
          cycle: { start: cycleStartIso, end: cycleEndIso, key: cycleKey },
          plan: { name: planName, status, cancelAtPeriodEnd },
          onDemand: { enabled: onDemandEnabled, monthlyLimitCents: onDemandEnabled ? onDemandMonthlyLimitCents : 0, usedCentsThisCycle },
          balances: { includedRemaining, purchasedRemaining, trialRemaining, creditsRemaining },
        },
        { headers: { "cache-control": "no-store" } },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load billing summary";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
  });
}


