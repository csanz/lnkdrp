import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { WorkspaceCreditBalanceModel } from "@/lib/models/WorkspaceCreditBalance";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { UsageAggCycleModel } from "@/lib/models/UsageAggCycle";
import { debugLog } from "@/lib/debug";
import { USD_CENTS_PER_CREDIT } from "@/lib/billing/pricing";

export type CreditsSnapshot = {
  ok: true;
  creditsRemaining: number;
  includedRemaining: number;
  paidRemaining: number;
  usedThisCycle: number;
  cycleStart: string | null;
  cycleEnd: string | null;
  includedThisCycle: number | null;
  onDemandEnabled: boolean;
  onDemandMonthlyLimitCents: number;
  onDemandUsedCreditsThisCycle: number;
  onDemandRemainingCreditsThisCycle: number;
  blocked: boolean;
};

function clampNonNegInt(n: unknown): number {
  const v = typeof n === "number" ? n : typeof n === "string" ? Number(n) : NaN;
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.floor(v));
}

function isProStatus(status: unknown): boolean {
  const s = typeof status === "string" ? status.trim().toLowerCase() : "";
  return s === "active" || s === "trialing";
}

function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

function startOfNextUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

/**
 * Compute a single credits snapshot for the active workspace.
 *
 * Source-of-truth:
 * - Billing cycle boundaries from `SubscriptionModel` (Stripe period start/end)
 * - Balances from `WorkspaceCreditBalanceModel`
 * - Usage in-cycle from `CreditLedgerModel` (charged rows within cycle window)
 */
export async function getCreditsSnapshot(params: { workspaceId: string; fast?: boolean }): Promise<CreditsSnapshot> {
  const workspaceId = params.workspaceId;
  const fast = Boolean(params.fast);
  if (!Types.ObjectId.isValid(workspaceId)) throw new Error("Invalid workspaceId");
  const orgId = new Types.ObjectId(workspaceId);

  await connectMongo();

  const now = new Date();
  const t0 = Date.now();
  const [sub, balRaw] = await Promise.all([
    SubscriptionModel.findOne({ orgId, isDeleted: { $ne: true } })
      .select({ status: 1, stripeSubscriptionId: 1, currentPeriodStart: 1, currentPeriodEnd: 1 })
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
  debugLog(2, "[credits:snapshot] base queries", { ms: Date.now() - t0, ops: 2 });

  const pro = isProStatus((sub as any)?.status);

  // Ensure a balance record exists so the dashboard can show Personal one-time credits
  // even before the first AI run triggers reservation initialization.
  let bal = balRaw as any;
  if (!bal) {
    const initTrialCredits = pro ? 0 : 50;
    const init: Partial<{
      trialCreditsRemaining: number;
      subscriptionCreditsRemaining: number;
      purchasedCreditsRemaining: number;
      onDemandEnabled: boolean;
      onDemandMonthlyLimitCents: number;
      dailyCreditCap: number | null;
      monthlyCreditCap: number | null;
      perRunCreditCapBasic: number;
      perRunCreditCapStandard: number;
      perRunCreditCapAdvanced: number;
      currentPeriodStart: Date | null;
      currentPeriodEnd: Date | null;
    }> = {
      trialCreditsRemaining: initTrialCredits,
      subscriptionCreditsRemaining: 0,
      purchasedCreditsRemaining: 0,
      onDemandEnabled: false,
      onDemandMonthlyLimitCents: 0,
      dailyCreditCap: null,
      monthlyCreditCap: null,
      perRunCreditCapBasic: 20,
      perRunCreditCapStandard: 60,
      perRunCreditCapAdvanced: 150,
      currentPeriodStart: null,
      currentPeriodEnd: null,
    };
    try {
      await WorkspaceCreditBalanceModel.updateOne({ workspaceId: orgId }, { $setOnInsert: init }, { upsert: true });
      bal = init;
    } catch {
      // best-effort; fall through with bal as null-ish
      bal = init;
    }
  }
  const subStart = (sub as any)?.currentPeriodStart instanceof Date ? (sub as any).currentPeriodStart : null;
  const subEnd = (sub as any)?.currentPeriodEnd instanceof Date ? (sub as any).currentPeriodEnd : null;
  const balStart = (bal as any)?.currentPeriodStart instanceof Date ? (bal as any).currentPeriodStart : null;
  const balEnd = (bal as any)?.currentPeriodEnd instanceof Date ? (bal as any).currentPeriodEnd : null;

  // Cycle window:
  // - Prefer Stripe period boundaries when present.
  // - Otherwise fall back to the balance-stored window.
  // - Otherwise use a stable UTC calendar month window. (This matches the credit ledger's default cycleKey.)
  const cycleStart = subStart && subEnd ? subStart : balStart && balEnd ? balStart : startOfUtcMonth(now);
  const cycleEnd = subStart && subEnd ? subEnd : balStart && balEnd ? balEnd : startOfNextUtcMonth(now);

  const subscriptionRemaining = clampNonNegInt((bal as any)?.subscriptionCreditsRemaining ?? 0);
  const trialRemaining = clampNonNegInt((bal as any)?.trialCreditsRemaining ?? 0);
  const purchasedRemaining = clampNonNegInt((bal as any)?.purchasedCreditsRemaining ?? 0);

  const includedRemaining = pro ? subscriptionRemaining : trialRemaining;
  const paidRemaining = purchasedRemaining;

  const onDemandEnabled = Boolean((bal as any)?.onDemandEnabled);
  const onDemandMonthlyLimitCents = clampNonNegInt((bal as any)?.onDemandMonthlyLimitCents ?? 0);
  const centsPerCredit = USD_CENTS_PER_CREDIT;
  // We treat on-demand as "off" unless explicitly enabled with a positive limit.
  const onDemandAllowed = onDemandEnabled && onDemandMonthlyLimitCents > 0;

  // Used this cycle: sum charged credits within the resolved billing cycle window.
  let usedThisCycle = 0;
  let onDemandUsedCreditsThisCycle = 0;
  {
    const t1 = Date.now();
    const cycleKey = `${workspaceId}:${cycleStart.toISOString()}`;

    // Prefer pre-aggregated cycle usage when available (fast path).
    const cycleAgg = await UsageAggCycleModel.findOne({ workspaceId: orgId, cycleKey })
      .select({ totalUsedCredits: 1, onDemandUsedCredits: 1 })
      .lean();

    if (cycleAgg) {
      usedThisCycle = clampNonNegInt((cycleAgg as any)?.totalUsedCredits ?? 0);
      onDemandUsedCreditsThisCycle = clampNonNegInt((cycleAgg as any)?.onDemandUsedCredits ?? 0);
      debugLog(2, "[credits:snapshot] cycle usage (agg)", { ms: Date.now() - t1, ops: 1 });
    } else if (fast) {
      // Fast mode (used by the dashboard header): do NOT fall back to ledger aggregation.
      // Ledger aggregation can be very expensive on large workspaces and isn't required for the header UX.
      //
      // To avoid *overstating* remaining credits, we conservatively treat on-demand as fully used
      // when aggregates are missing.
      usedThisCycle = 0;
      onDemandUsedCreditsThisCycle = onDemandAllowed ? Math.floor(onDemandMonthlyLimitCents / centsPerCredit) : 0;
      debugLog(2, "[credits:snapshot] cycle usage (fast; missing agg)", { ms: Date.now() - t1, ops: 1 });
    } else {
      // Fallback: bounded aggregate over the ledger for correctness while aggregates backfill.
      const agg = await CreditLedgerModel.aggregate([
        {
          $match: {
            workspaceId: orgId,
            status: "charged",
            eventType: "ai_run",
            createdDate: { $gte: cycleStart, $lt: cycleEnd },
          },
        },
        {
          $group: {
            _id: null,
            sum: { $sum: "$creditsCharged" },
            onDemandSum: { $sum: "$creditsFromOnDemand" },
          },
        },
      ]);
      usedThisCycle = clampNonNegInt((agg as any)?.[0]?.sum ?? 0);
      onDemandUsedCreditsThisCycle = clampNonNegInt((agg as any)?.[0]?.onDemandSum ?? 0);
      debugLog(2, "[credits:snapshot] cycle usage (ledger agg)", { ms: Date.now() - t1, ops: 1 });
    }
  }

  // Blocked when no remaining credits and on-demand is off (or has no remaining headroom).
  const onDemandRemainingCreditsThisCycle = onDemandAllowed
    ? Math.max(0, Math.floor(onDemandMonthlyLimitCents / centsPerCredit) - onDemandUsedCreditsThisCycle)
    : 0;
  const paidRemainingWithOnDemand = paidRemaining + onDemandRemainingCreditsThisCycle;
  const creditsRemaining = includedRemaining + paidRemainingWithOnDemand;
  const blocked = creditsRemaining <= 0;

  return {
    ok: true,
    creditsRemaining,
    includedRemaining,
    paidRemaining: paidRemainingWithOnDemand,
    usedThisCycle,
    cycleStart: cycleStart ? cycleStart.toISOString() : null,
    cycleEnd: cycleEnd ? cycleEnd.toISOString() : null,
    includedThisCycle: pro ? 300 : trialRemaining ? 50 : null,
    onDemandEnabled,
    onDemandMonthlyLimitCents,
    onDemandUsedCreditsThisCycle,
    onDemandRemainingCreditsThisCycle,
    blocked,
  };
}


