import { Types, type ClientSession } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { OrgModel } from "@/lib/models/Org";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { WorkspaceCreditBalanceModel } from "@/lib/models/WorkspaceCreditBalance";

export const INCLUDED_CREDITS_PER_CYCLE = 300;

/**
 * One-time starter credits for personal Free workspaces (no cycle reset), granted by
 * `starterCreditsForWorkspace` (`creditService.ts`, used by both the reserve path and the
 * dashboard snapshot) and shown on the pricing card. Team workspaces always start at 0 so a user
 * cannot farm credits by creating orgs. Set to 0 to skip the grant entirely.
 */
export const FREE_STARTER_CREDITS = 50;

/**
 * Monthly floor for personal Free workspaces: on the first evaluation in each UTC month the trial
 * bucket is raised to at least this many credits (`max(trial, floor)`, never additive). Applied by
 * `grantFreeMonthlyFloor`, at most once per workspace per month.
 */
export const FREE_MONTHLY_FLOOR_CREDITS = 10;

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

/** UTC calendar month of `now` as `YYYY-MM` (the value stored in `WorkspaceCreditBalance.freeFloorMonth`). */
export function freeFloorMonth(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/** Idempotency key for a workspace's Free floor in the month of `now`: `free:{orgId}:{YYYY-MM}`. */
export function freeFloorMonthKey(orgId: string | Types.ObjectId, now: Date): string {
  return `free:${String(orgId)}:${freeFloorMonth(now)}`;
}

export type FreeMonthlyFloorResult = {
  /** True when this call claimed the month's floor for an eligible workspace (credits may still be 0). */
  applied: boolean;
  /** Credits added to the trial bucket (0 when the balance was already at or above the floor). */
  creditsAdded: number;
  monthKey: string;
  /**
   * - `applied`: this call claimed the month (see `creditsAdded`)
   * - `already_applied`: the month was already claimed, or the workspace has no balance row
   * - `pro`: subscription active/trialing; month marked, no credits
   * - `team`: non-personal (or missing) org; month marked, no credits
   */
  reason: "applied" | "already_applied" | "pro" | "team";
};

/**
 * Top up a personal Free workspace's trial bucket to `FREE_MONTHLY_FLOOR_CREDITS` once per UTC month.
 *
 * Rules:
 * - `trialCreditsRemaining = max(trialCreditsRemaining, 10)`; never additive.
 * - Idempotent per workspace per month: the balance row's `freeFloorMonth` marker is claimed with a
 *   conditional update (`freeFloorMonth: { $ne: month }`), so concurrent evaluators cannot both apply.
 * - Pro (subscription active/trialing) and team workspaces get no credits, but the month is still
 *   marked so repeated evaluations stay cheap; a workspace that downgrades from Pro therefore gets
 *   the floor in the first month it is evaluated while Free without an earlier mark that month.
 * - Brand-new balance rows are seeded with the current month's marker (reserve path + snapshot), so
 *   a new workspace on its 50 starter credits does not drop to the floor later that month.
 * - When credits are added, one `free_floor_grant` ledger row (idempotencyKey = month key) records
 *   the top-up for Billing history. Balance update and ledger row share one transaction: the
 *   caller's `session` when given (reserve path), otherwise a new one.
 *
 * Does not create a balance row. Errors: throws on an invalid id or DB failure.
 */
export async function grantFreeMonthlyFloor(params: {
  workspaceId: string;
  now?: Date;
  session?: ClientSession | null;
}): Promise<FreeMonthlyFloorResult> {
  const workspaceId = params.workspaceId;
  if (!Types.ObjectId.isValid(workspaceId)) throw new Error("Invalid workspaceId");
  const orgId = new Types.ObjectId(workspaceId);
  const now = params.now instanceof Date && Number.isFinite(params.now.getTime()) ? params.now : new Date();
  const month = freeFloorMonth(now);
  const monthKey = freeFloorMonthKey(workspaceId, now);

  await connectMongo();

  const [org, sub] = await Promise.all([
    OrgModel.findOne({ _id: orgId, isDeleted: { $ne: true } }).select({ type: 1 }).lean(),
    SubscriptionModel.findOne({ orgId, isDeleted: { $ne: true } }).select({ status: 1 }).lean(),
  ]);
  const statusRaw = (sub as { status?: unknown } | null)?.status;
  const status = typeof statusRaw === "string" ? statusRaw.trim().toLowerCase() : "";
  const isPro = status === "active" || status === "trialing";
  const isPersonal = (org as { type?: unknown } | null)?.type === "personal";

  const unclaimed = { workspaceId: orgId, freeFloorMonth: { $ne: month } };

  if (isPro || !isPersonal) {
    // Mark only (no credits) so later evaluations this month skip the plan lookups.
    await WorkspaceCreditBalanceModel.updateOne(unclaimed, { $set: { freeFloorMonth: month } }, params.session ? { session: params.session } : {});
    return { applied: false, creditsAdded: 0, monthKey, reason: isPro ? "pro" : "team" };
  }

  const apply = async (session: ClientSession): Promise<FreeMonthlyFloorResult> => {
    // Claim the month and raise the floor in one atomic write; returns the pre-update row.
    const before = await WorkspaceCreditBalanceModel.findOneAndUpdate(
      unclaimed,
      { $set: { freeFloorMonth: month }, $max: { trialCreditsRemaining: FREE_MONTHLY_FLOOR_CREDITS } },
      { session, new: false, projection: { _id: 1, trialCreditsRemaining: 1 } },
    ).lean();
    if (!before) return { applied: false, creditsAdded: 0, monthKey, reason: "already_applied" };

    const prevRaw = Number((before as { trialCreditsRemaining?: unknown }).trialCreditsRemaining ?? 0);
    const prev = Number.isFinite(prevRaw) ? Math.max(0, Math.floor(prevRaw)) : 0;
    const creditsAdded = Math.max(0, FREE_MONTHLY_FLOOR_CREDITS - prev);

    if (creditsAdded > 0) {
      await CreditLedgerModel.create(
        [
          {
            workspaceId: orgId,
            userId: null,
            docId: null,
            actionType: "unknown",
            qualityTier: "basic",
            status: "charged",
            eventType: "free_floor_grant",
            cycleKey: null,
            creditsEstimated: creditsAdded,
            creditsReserved: 0,
            creditsCharged: 0,
            idempotencyKey: monthKey,
            requestId: null,
            stripeUsageReportedAt: null,
          },
        ],
        { session },
      );
    }
    return { applied: true, creditsAdded, monthKey, reason: "applied" };
  };

  if (params.session) return await apply(params.session);

  // Own transaction (cron, snapshot). `Model.startSession` uses the model's connection.
  const session = await WorkspaceCreditBalanceModel.startSession();
  try {
    let result: FreeMonthlyFloorResult = { applied: false, creditsAdded: 0, monthKey, reason: "already_applied" };
    await session.withTransaction(async () => {
      result = await apply(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
