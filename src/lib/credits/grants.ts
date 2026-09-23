import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { WorkspaceCreditBalanceModel } from "@/lib/models/WorkspaceCreditBalance";

export const INCLUDED_CREDITS_PER_CYCLE = 500;

/**
 * One-time starter credits for every Free workspace, personal or team (no cycle reset), granted by
 * `starterCreditsForWorkspace` (`creditService.ts`, used by both the reserve path and the
 * dashboard snapshot) and shown on the pricing card. Each workspace is its own customer with its
 * own plan, so each starts with these. Set to 0 to skip the grant entirely.
 */
export const FREE_STARTER_CREDITS = 100;


/**
 * Which month of the subscription we are in, counted from the period start.
 *
 * On a monthly plan this is always 0 and the key is unchanged. It exists for annual plans, where
 * Stripe's "current period" is a *year*: see `buildCycleKey`.
 */
export function creditMonthIndex(periodStart: Date, now: Date): number {
  const a = periodStart.getTime();
  const b = now.getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  const months =
    (now.getUTCFullYear() - periodStart.getUTCFullYear()) * 12 + (now.getUTCMonth() - periodStart.getUTCMonth());
  // Only count a month once its day-of-month has come round, so a period starting on the 31st does
  // not advance on the 1st.
  const dayReached = now.getUTCDate() >= periodStart.getUTCDate();
  return Math.max(0, months - (dayReached ? 0 : 1));
}

/** Longer than this and a Stripe period is not a month, so it holds several credit windows. */
const MONTHLY_PERIOD_MAX_DAYS = 45;

/**
 * Which credit window a subscription is in right now, from its Stripe period alone.
 *
 * Derived from the span rather than from a stored `interval`, so it is right for rows written
 * before anyone thought about annual billing, and right for a quarterly price nobody has created
 * yet. A period of a month or less is one window (index 0, the historical behaviour); a longer one
 * is split into months.
 */
export function creditWindowIndex(periodStart: Date, periodEnd: Date | null, now: Date): number {
  if (!(periodStart instanceof Date) || !Number.isFinite(periodStart.getTime())) return 0;
  if (!(periodEnd instanceof Date) || !Number.isFinite(periodEnd.getTime())) return 0;
  const days = (periodEnd.getTime() - periodStart.getTime()) / 86_400_000;
  if (days <= MONTHLY_PERIOD_MAX_DAYS) return 0;
  return creditMonthIndex(periodStart, now);
}

/**
 * The idempotency key for one included-credits grant.
 *
 * `${stripeSubscriptionId}:${currentPeriodStartUnixSeconds}` for a monthly subscription, which is
 * one grant per Stripe period and exactly what it has always been — existing rows keep their keys,
 * so nothing is re-granted.
 *
 * **Annual subscriptions need a suffix, and this is why.** The grant is idempotent per cycleKey and
 * the key is derived from Stripe's current period, so on a yearly plan there is one period, one
 * key, and one grant: 500 credits to cover twelve months instead of 500 a month. `:m<N>` splits the
 * year into twelve monthly windows. Pass `monthIndex` for an annual plan and leave it off for a
 * monthly one; `m0` is deliberately *not* written, so the first month of an annual period and every
 * month of a monthly one share the unsuffixed shape and no existing key changes meaning.
 */
export function buildCycleKey(params: {
  stripeSubscriptionId: string;
  currentPeriodStart: Date;
  /** 0-based month within the period. Omit (or 0) for a monthly subscription. */
  monthIndex?: number;
}): string {
  const subId = (params.stripeSubscriptionId ?? "").trim();
  const ms = params.currentPeriodStart instanceof Date ? params.currentPeriodStart.getTime() : NaN;
  const unix = Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN;
  const start = Number.isFinite(unix) ? String(unix) : "";
  const n = Number.isFinite(params.monthIndex) ? Math.max(0, Math.floor(params.monthIndex as number)) : 0;
  return n > 0 ? `${subId}:${start}:m${n}` : `${subId}:${start}`;
}

/**
 * Idempotently grant/reset included credits for a new billing cycle.
 *
 * Requirements:
 * - idempotent per (workspaceId, cycleKey)
 * - atomic: ledger + balance update in one transaction
 */
export async function grantCycleIncludedCredits(params: {
  workspaceId: string;
  stripeSubscriptionId: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date | null;
  /**
   * 0-based month within the Stripe period, for annual plans. Omit for monthly, where the period
   * is already a month. See `buildCycleKey`.
   */
  monthIndex?: number;
}): Promise<{ ok: true; cycleKey: string; alreadyGranted: boolean }> {
  const workspaceId = params.workspaceId;
  if (!Types.ObjectId.isValid(workspaceId)) throw new Error("Invalid workspaceId");
  const orgId = new Types.ObjectId(workspaceId);
  const cycleKey = buildCycleKey({
    stripeSubscriptionId: params.stripeSubscriptionId,
    currentPeriodStart: params.currentPeriodStart,
    monthIndex: params.monthIndex,
  });
  if (!cycleKey || cycleKey.includes("undefined")) throw new Error("Invalid cycleKey");

  await connectMongo();
  const session = await (await import("mongoose")).default.startSession();
  try {
    return await session.withTransaction(async () => {
      const existing = await CreditLedgerModel.findOne({
        workspaceId: orgId,
        eventType: "cycle_grant_included",
        cycleKey,
      })
        .select({ _id: 1 })
        .session(session)
        .lean();
      if (existing?._id) return { ok: true, cycleKey, alreadyGranted: true };

      // Ensure balance exists.
      await WorkspaceCreditBalanceModel.updateOne(
        { workspaceId: orgId },
        {
          $setOnInsert: {
            workspaceId: orgId,
            trialCreditsRemaining: 0,
            subscriptionCreditsRemaining: 0,
            purchasedCreditsRemaining: 0,
            onDemandEnabled: false,
            onDemandMonthlyLimitCents: 0,
            perRunCreditCapBasic: 20,
            perRunCreditCapStandard: 60,
            perRunCreditCapAdvanced: 150,
          },
        },
        { upsert: true, session },
      );

      // Reset included credits (no rollover) + sync cycle boundaries for UI and enforcement.
      await WorkspaceCreditBalanceModel.updateOne(
        { workspaceId: orgId },
        {
          $set: {
            subscriptionCreditsRemaining: INCLUDED_CREDITS_PER_CYCLE,
            // Pro has no daily brake; a row seeded while the workspace was Free still carries it.
            dailyCreditCap: null,
            currentPeriodStart: params.currentPeriodStart,
            currentPeriodEnd: params.currentPeriodEnd ?? null,
          },
        },
        { session },
      );

      // Ledger entry: append-only record keyed by cycleKey.
      try {
        await CreditLedgerModel.create(
          [
            {
              workspaceId: orgId,
              userId: null,
              docId: null,
              actionType: "unknown",
              qualityTier: "basic",
              status: "charged",
              eventType: "cycle_grant_included",
              cycleKey,
              creditsEstimated: INCLUDED_CREDITS_PER_CYCLE,
              creditsReserved: 0,
              creditsCharged: 0,
              idempotencyKey: `cycle_grant_included:${cycleKey}`,
              requestId: null,
              stripeUsageReportedAt: null,
            },
          ],
          { session },
        );
      } catch (e) {
        // Concurrency safety: if another transaction already inserted the ledger row,
        // the (workspaceId,idempotencyKey) unique index will raise a duplicate key error.
        const code = (e as any)?.code;
        if (code === 11000) return { ok: true, cycleKey, alreadyGranted: true };
        throw e;
      }

      return { ok: true, cycleKey, alreadyGranted: false };
    });
  } finally {
    await session.endSession();
  }
}
