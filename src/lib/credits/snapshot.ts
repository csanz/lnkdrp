import { Types } from "mongoose";
import {
  FREE_STARTER_CREDITS,
  INCLUDED_CREDITS_PER_CYCLE,
} from "@/lib/credits/grants";
import { defaultBalanceForWorkspace } from "@/lib/credits/creditService";

import { connectMongo } from "@/lib/mongodb";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { isProSubscription } from "@/lib/billing/subscriptionState";
import { WorkspaceCreditBalanceModel } from "@/lib/models/WorkspaceCreditBalance";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { UsageAggCycleModel } from "@/lib/models/UsageAggCycle";
import { debugLog } from "@/lib/debug";
import { USD_CENTS_PER_CREDIT } from "@/lib/billing/pricing";
import { UNLIMITED_LIMIT_CENTS } from "@/lib/billing/limits";

/** Lean document shape from SubscriptionModel query */
type SubscriptionDoc = {
  status?: string;
  stripeSubscriptionId?: string;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
} | null;

/** Lean document shape from WorkspaceCreditBalanceModel query */
type WorkspaceCreditBalanceDoc = {
  trialCreditsRemaining?: number;
  subscriptionCreditsRemaining?: number;
  purchasedCreditsRemaining?: number;
  onDemandEnabled?: boolean;
  onDemandMonthlyLimitCents?: number;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
} | null;

/** Lean document shape from UsageAggCycleModel query */
type UsageAggCycleDoc = {
  totalUsedCredits?: number;
  onDemandUsedCredits?: number;
} | null;

/** Aggregation result shape from CreditLedgerModel */
type CreditLedgerAggResult = {
  _id: null;
  sum?: number;
  onDemandSum?: number;
}[];

export type CreditsSnapshot = {
  ok: true;
  /**
   * Credits the workspace holds right now: included (Pro's monthly credits, Free's starter credits,
   * and any of either left over) plus purchased packs. The number to show as "credits left".
   * On-demand headroom is not in it — that is permission to keep going and be billed, not credits
   * held; see `spendableRemaining`.
   */
  creditsRemaining: number;
  /** Included credits left: the subscription bucket plus the starter bucket. */
  includedRemaining: number;
  /** Credits left from purchased packs. */
  purchasedRemaining: number;
  /** @deprecated Same as `purchasedRemaining`. Until 2026-09-17 it also counted on-demand headroom. */
  paidRemaining: number;
  /**
   * What an AI run can draw on: `creditsRemaining` plus this cycle's on-demand headroom. `null` when
   * the on-demand limit is unlimited. Use it to decide whether a run can go ahead, never for display.
   */
  spendableRemaining: number | null;
  usedThisCycle: number;
  cycleStart: string | null;
  cycleEnd: string | null;
  includedThisCycle: number | null;
  /**
   * Always `null` since 2026-09-15. It carried the date a Free workspace's monthly floor top-up
   * would land; Free credits no longer come back on a date (50 to start, then pay-as-you-go or
   * Pro). Kept so clients written against the field keep parsing. Pro uses `cycleEnd`.
   */
  resetsAt: string | null;
  /** On-demand is on: Pro, with the toggle on and a positive limit. Always `false` off Pro. */
  onDemandEnabled: boolean;
  /** The effective on-demand limit; `0` when on-demand is off or the workspace is not on Pro. */
  onDemandMonthlyLimitCents: number;
  /** Credits billed on-demand this cycle, reported even after on-demand is turned off (still invoiced). */
  onDemandUsedCreditsThisCycle: number;
  onDemandRemainingCreditsThisCycle: number;
  blocked: boolean;
};

/**
 * Coerces an unknown value into a non-negative integer.
 *
 * Exists to keep billing math resilient to null/strings/legacy schema shapes.
 */
function clampNonNegInt(n: unknown): number {
  const v = typeof n === "number" ? n : typeof n === "string" ? Number(n) : NaN;
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.floor(v));
}

/**
 * Returns the UTC start of the month for a given date.
 *
 * Used as a stable fallback billing window when Stripe/balance boundaries are missing.
 */
function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

/**
 * Returns the UTC start of the next month for a given date.
 *
 * Used to close the fallback cycle window when Stripe/balance boundaries are missing.
 */
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
 *
 * `fast=true` avoids expensive ledger aggregation when pre-aggregates are missing; it trades accuracy
 * for speed in header/dashboard contexts and may conservatively treat on-demand as fully used.
 *
 * Errors: throws when `workspaceId` is invalid or when required DB operations fail.
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
      .select({ status: 1, kind: 1, stripeSubscriptionId: 1, currentPeriodStart: 1, currentPeriodEnd: 1 })
      .lean() as Promise<SubscriptionDoc>,
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
      .lean() as Promise<WorkspaceCreditBalanceDoc>,
  ]);
  debugLog(2, "[credits:snapshot] base queries", { ms: Date.now() - t0, ops: 2 });

  // Pro means the Pro price, not merely an active subscription: a legacy pay-as-you-go workspace is
  // active in Stripe and is still Free.
  const pro = isProSubscription(sub);

  // Ensure a balance record exists so the dashboard can show Personal one-time credits
  // even before the first AI run triggers reservation initialization. The seed comes from the
  // same helper the reserve path uses (`defaultBalanceForWorkspace`), so the starter grant and the
  // Free daily cap land exactly once, on whichever path runs first.
  let bal: WorkspaceCreditBalanceDoc = balRaw;
  if (!bal) {
    const initSeed = await defaultBalanceForWorkspace(orgId);
    try {
      await WorkspaceCreditBalanceModel.updateOne(
        { workspaceId: orgId },
        { $setOnInsert: { workspaceId: orgId, ...initSeed } },
        { upsert: true },
      );
      bal = initSeed as WorkspaceCreditBalanceDoc;
    } catch {
      // best-effort; fall through with bal as null-ish
      bal = initSeed as WorkspaceCreditBalanceDoc;
    }
  }
  const subStart = sub?.currentPeriodStart instanceof Date ? sub.currentPeriodStart : null;
  const subEnd = sub?.currentPeriodEnd instanceof Date ? sub.currentPeriodEnd : null;
  const balStart = bal?.currentPeriodStart instanceof Date ? bal.currentPeriodStart : null;
  const balEnd = bal?.currentPeriodEnd instanceof Date ? bal.currentPeriodEnd : null;

  // Cycle window:
  // - Prefer Stripe period boundaries when present.
  // - Otherwise fall back to the balance-stored window.
  // - Otherwise use a stable UTC calendar month window. (This matches the credit ledger's default cycleKey.)
  const cycleStart = subStart && subEnd ? subStart : balStart && balEnd ? balStart : startOfUtcMonth(now);
  const cycleEnd = subStart && subEnd ? subEnd : balStart && balEnd ? balEnd : startOfNextUtcMonth(now);

  const subscriptionRemaining = clampNonNegInt(bal?.subscriptionCreditsRemaining ?? 0);
  const trialRemaining = clampNonNegInt(bal?.trialCreditsRemaining ?? 0);
  const purchasedRemaining = clampNonNegInt(bal?.purchasedCreditsRemaining ?? 0);

  // Both buckets, whatever the plan: a run spends the subscription bucket, then the starter bucket,
  // then purchased credits (`allocateBuckets` in serviceCore), so starter credits left over after an
  // upgrade (or Pro credits left after a downgrade) are still spendable and belong in the count.
  const includedRemaining = subscriptionRemaining + trialRemaining;

  // On-demand is a Pro feature: once the monthly credits run out, keep going and pay per credit.
  // Free workspaces buy credit packs instead, so a stored toggle on a non-Pro workspace (a legacy
  // pay-as-you-go subscription, or a Pro that lapsed) counts as off.
  const storedOnDemandLimitCents = clampNonNegInt(bal?.onDemandMonthlyLimitCents ?? 0);
  const onDemandAllowed = pro && Boolean(bal?.onDemandEnabled) && storedOnDemandLimitCents > 0;
  const onDemandEnabled = onDemandAllowed;
  const onDemandMonthlyLimitCents = onDemandAllowed ? storedOnDemandLimitCents : 0;
  const centsPerCredit = USD_CENTS_PER_CREDIT;
  const onDemandUnlimited = onDemandAllowed && onDemandMonthlyLimitCents >= UNLIMITED_LIMIT_CENTS;

  // Used this cycle: sum charged credits within the resolved billing cycle window.
  let usedThisCycle = 0;
  let onDemandUsedCreditsThisCycle = 0;
  let usageReliable = true;
  {
    const t1 = Date.now();
    const cycleKey = `${workspaceId}:${cycleStart.toISOString()}`;

    // Prefer pre-aggregated cycle usage when available (fast path).
    const cycleAgg = await UsageAggCycleModel.findOne({ workspaceId: orgId, cycleKey })
      .select({ totalUsedCredits: 1, onDemandUsedCredits: 1 })
      .lean() as UsageAggCycleDoc;

    if (cycleAgg) {
      usedThisCycle = clampNonNegInt(cycleAgg.totalUsedCredits ?? 0);
      onDemandUsedCreditsThisCycle = clampNonNegInt(cycleAgg.onDemandUsedCredits ?? 0);
      debugLog(2, "[credits:snapshot] cycle usage (agg)", { ms: Date.now() - t1, ops: 1 });
    } else if (fast) {
      // Fast mode (used by the dashboard header): do NOT fall back to ledger aggregation.
      // Ledger aggregation can be very expensive on large workspaces and isn't required for the header UX.
      //
      // NOTE: We intentionally avoid showing a false "blocked" state in fast mode.
      // When aggregates are missing, on-demand usage is treated as unknown (assume 0 used).
      usedThisCycle = 0;
      onDemandUsedCreditsThisCycle = 0;
      usageReliable = false;
      debugLog(2, "[credits:snapshot] cycle usage (fast; missing agg)", { ms: Date.now() - t1, ops: 1, usageReliable: false });
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
      ]) as CreditLedgerAggResult;
      usedThisCycle = clampNonNegInt(agg[0]?.sum ?? 0);
      onDemandUsedCreditsThisCycle = clampNonNegInt(agg[0]?.onDemandSum ?? 0);
      debugLog(2, "[credits:snapshot] cycle usage (ledger agg)", { ms: Date.now() - t1, ops: 1 });
    }
  }

  // Blocked when no remaining credits and on-demand is off (or has no remaining headroom).
  const onDemandRemainingCreditsThisCycle = onDemandUnlimited
    ? 0
    : onDemandAllowed
      ? Math.max(0, Math.floor(onDemandMonthlyLimitCents / centsPerCredit) - onDemandUsedCreditsThisCycle)
      : 0;
  const creditsRemaining = includedRemaining + purchasedRemaining;
  const spendableRemaining = onDemandUnlimited ? null : creditsRemaining + onDemandRemainingCreditsThisCycle;

  const blocked =
    creditsRemaining > 0
      ? false
      : onDemandUnlimited
        ? false
        : onDemandAllowed
          ? usageReliable
            ? onDemandRemainingCreditsThisCycle <= 0
            : false
          : true;

  return {
    ok: true,
    creditsRemaining,
    includedRemaining,
    purchasedRemaining,
    paidRemaining: purchasedRemaining,
    spendableRemaining,
    usedThisCycle,
    cycleStart: cycleStart ? cycleStart.toISOString() : null,
    cycleEnd: cycleEnd ? cycleEnd.toISOString() : null,
    includedThisCycle: pro ? INCLUDED_CREDITS_PER_CYCLE : trialRemaining ? FREE_STARTER_CREDITS : null,
    // Free credits never come back on a date any more (the monthly floor ended 2026-09-15); kept
    // as `null` so clients written against the field keep parsing.
    resetsAt: null,
    onDemandEnabled,
    onDemandMonthlyLimitCents,
    onDemandUsedCreditsThisCycle,
    onDemandRemainingCreditsThisCycle,
    blocked,
  };
}
