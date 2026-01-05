import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { WorkspaceCreditBalanceModel } from "@/lib/models/WorkspaceCreditBalance";

export const INCLUDED_CREDITS_PER_CYCLE = 300;

/**
 * cycleKey = `${stripeSubscriptionId}:${currentPeriodStartUnixSeconds}`
 */
export function buildCycleKey(params: { stripeSubscriptionId: string; currentPeriodStart: Date }): string {
  const subId = (params.stripeSubscriptionId ?? "").trim();
  const ms = params.currentPeriodStart instanceof Date ? params.currentPeriodStart.getTime() : NaN;
  const unix = Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN;
  const start = Number.isFinite(unix) ? String(unix) : "";
  return `${subId}:${start}`;
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
}): Promise<{ ok: true; cycleKey: string; alreadyGranted: boolean }> {
  const workspaceId = params.workspaceId;
  if (!Types.ObjectId.isValid(workspaceId)) throw new Error("Invalid workspaceId");
  const orgId = new Types.ObjectId(workspaceId);
  const cycleKey = buildCycleKey({
    stripeSubscriptionId: params.stripeSubscriptionId,
    currentPeriodStart: params.currentPeriodStart,
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


