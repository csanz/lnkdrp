import { Types } from "mongoose";
import {
  FREE_MONTHLY_FLOOR_CREDITS,
  FREE_STARTER_CREDITS,
  INCLUDED_CREDITS_PER_CYCLE,
  freeFloorMonth,
  grantFreeMonthlyFloor,
} from "@/lib/credits/grants";
import { defaultBalanceForWorkspace } from "@/lib/credits/creditService";

import { connectMongo } from "@/lib/mongodb";
import { OrgModel } from "@/lib/models/Org";
import { SubscriptionModel } from "@/lib/models/Subscription";
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
  freeFloorMonth?: string | null;
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
  creditsRemaining: number;
  includedRemaining: number;
  paidRemaining: number;
  usedThisCycle: number;
  cycleStart: string | null;
  cycleEnd: string | null;
  includedThisCycle: number | null;
  /**
   * When the included credits next change without a purchase, ISO string. Set only for a personal
   * Free workspace whose trial bucket is at or below the monthly floor: the first of next UTC month,
   * when it tops up to `FREE_MONTHLY_FLOOR_CREDITS` (then `includedThisCycle` is that floor). `null`
   * otherwise (Pro uses `cycleEnd`).
   */
  resetsAt: string | null;
  onDemandEnabled: boolean;
  onDemandMonthlyLimitCents: number;
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
 * Returns true when a Stripe subscription status should be treated as "pro".
 *
 * Exists to map Stripe status strings into a simple boolean used throughout credit logic.
 */
function isProStatus(status: unknown): boolean {
  const s = typeof status === "string" ? status.trim().toLowerCase() : "";
  return s === "active" || s === "trialing";
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
      .select({ status: 1, stripeSubscriptionId: 1, currentPeriodStart: 1, currentPeriodEnd: 1 })
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
        freeFloorMonth: 1,
      })
      .lean() as Promise<WorkspaceCreditBalanceDoc>,
  ]);
  debugLog(2, "[credits:snapshot] base queries", { ms: Date.now() - t0, ops: 2 });

  const pro = isProStatus(sub?.status);

  // Ensure a balance record exists so the dashboard can show Personal one-time credits
  // even before the first AI run triggers reservation initialization. The seed comes from the
  // same helper the reserve path uses (`defaultBalanceForWorkspace`), so a team workspace never
  // gets the personal starter grant here and the Free daily cap lands on whichever path runs first.
  let bal: WorkspaceCreditBalanceDoc = balRaw;
  const month = freeFloorMonth(now);
  if (bal && bal.freeFloorMonth !== month) {
    // Free monthly floor (once per UTC month; Pro/team are only marked). Best-effort: the dashboard
    // must still load if the top-up fails; the reserve path and the cron re-evaluate it.
    try {
      const floor = await grantFreeMonthlyFloor({ workspaceId, now });
      if (floor.creditsAdded > 0) {
        bal = {
          ...bal,
          trialCreditsRemaining: Math.max(clampNonNegInt(bal.trialCreditsRemaining), FREE_MONTHLY_FLOOR_CREDITS),
          freeFloorMonth: month,
        };
      }
    } catch (err) {
      debugLog(1, "[credits:snapshot] free floor failed", { err: err instanceof Error ? err.message : String(err) });
    }
  }
  if (!bal) {
    const initSeed = await defaultBalanceForWorkspace(orgId);
    try {
      await WorkspaceCreditBalanceModel.updateOne(
        { workspaceId: orgId },
        // A new row already covers this month's Free floor (the starter grant is larger).
        { $setOnInsert: { workspaceId: orgId, ...initSeed, freeFloorMonth: month } },
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

  const includedRemaining = pro ? subscriptionRemaining : trialRemaining;

  // Personal Free at or below the monthly floor: report the floor as this month's allowance and when
  // it next tops up. (At exactly the floor, e.g. right after a top-up, the 50 starter no longer applies.)
  let freeFloorResetsAt: Date | null = null;
  if (!pro && trialRemaining <= FREE_MONTHLY_FLOOR_CREDITS) {
    const org = (await OrgModel.findOne({ _id: orgId, isDeleted: { $ne: true } })
      .select({ type: 1 })
      .lean()) as { type?: unknown } | null;
    if (org?.type === "personal") freeFloorResetsAt = startOfNextUtcMonth(now);
  }
  const paidRemaining = purchasedRemaining;

  const onDemandEnabled = Boolean(bal?.onDemandEnabled);
  const onDemandMonthlyLimitCents = clampNonNegInt(bal?.onDemandMonthlyLimitCents ?? 0);
  const centsPerCredit = USD_CENTS_PER_CREDIT;
  // We treat on-demand as "off" unless explicitly enabled with a positive limit.
  const onDemandAllowed = onDemandEnabled && onDemandMonthlyLimitCents > 0;
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
  const paidRemainingWithOnDemand = paidRemaining + onDemandRemainingCreditsThisCycle;
  const creditsRemaining = includedRemaining + paidRemainingWithOnDemand;

  const baseRemaining = includedRemaining + paidRemaining;
  const blocked =
    baseRemaining > 0
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
    paidRemaining: paidRemainingWithOnDemand,
    usedThisCycle,
    cycleStart: cycleStart ? cycleStart.toISOString() : null,
    cycleEnd: cycleEnd ? cycleEnd.toISOString() : null,
    includedThisCycle: pro
      ? INCLUDED_CREDITS_PER_CYCLE
      : freeFloorResetsAt
        ? FREE_MONTHLY_FLOOR_CREDITS
        : trialRemaining
          ? FREE_STARTER_CREDITS
          : null,
    resetsAt: freeFloorResetsAt ? freeFloorResetsAt.toISOString() : null,
    onDemandEnabled,
    onDemandMonthlyLimitCents,
    onDemandUsedCreditsThisCycle,
    onDemandRemainingCreditsThisCycle,
    blocked,
  };
}
