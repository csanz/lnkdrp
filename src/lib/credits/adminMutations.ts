import { Types } from "mongoose";
import crypto from "crypto";

import { connectMongo } from "@/lib/mongodb";
import { WorkspaceCreditBalanceModel } from "@/lib/models/WorkspaceCreditBalance";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { grantCycleIncludedCredits } from "@/lib/credits/grants";
import { getCreditsSnapshot, type CreditsSnapshot } from "@/lib/credits/snapshot";

export type AdminCreditMutationAction = "grant_included" | "grant_on_demand" | "burn";

function isProStatus(status: unknown): boolean {
  const s = typeof status === "string" ? status.trim().toLowerCase() : "";
  return s === "active" || s === "trialing";
}

function asPositiveInt(v: unknown, opts?: { max?: number }): number | null {
  const max = opts?.max ?? Number.POSITIVE_INFINITY;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i < 1) return null;
  if (i > max) return null;
  return i;
}

function nonEmptyString(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
}

function uuidKey(prefix: string) {
  const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
  return `${prefix}:${id}`;
}

export async function adminMutateCredits(params: {
  workspaceId: string;
  action: AdminCreditMutationAction;
  amount: number;
  reason: string;
  actorUserId: string | null;
  actorEmail: string | null;
}): Promise<{ ok: true; snapshot: CreditsSnapshot }> {
  const workspaceId = params.workspaceId;
  if (!Types.ObjectId.isValid(workspaceId)) throw new Error("Invalid workspaceId");
  const amount = asPositiveInt(params.amount, { max: 1_000_000 });
  if (!amount) throw new Error("amount must be a positive integer (max 1000000)");
  const reason = nonEmptyString(params.reason);
  if (!reason) throw new Error("reason is required");

  await connectMongo();
  const session = await (await import("mongoose")).default.startSession();
  try {
    await session.withTransaction(async () => {
      const orgId = new Types.ObjectId(workspaceId);

      const subDoc = await SubscriptionModel.findOne({ orgId, isDeleted: { $ne: true } })
        .select({ status: 1 })
        .session(session)
        .lean();
      const pro = isProStatus((subDoc as any)?.status);

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

      const bal = await WorkspaceCreditBalanceModel.findOne({ workspaceId: orgId })
        .select({ trialCreditsRemaining: 1, subscriptionCreditsRemaining: 1, purchasedCreditsRemaining: 1 })
        .session(session)
        .lean();

      const trial = Math.max(0, Math.floor(Number((bal as any)?.trialCreditsRemaining ?? 0) || 0));
      const sub = Math.max(0, Math.floor(Number((bal as any)?.subscriptionCreditsRemaining ?? 0) || 0));
      const purchased = Math.max(0, Math.floor(Number((bal as any)?.purchasedCreditsRemaining ?? 0) || 0));

      let incSub = 0;
      let incPurchased = 0;
      let incTrial = 0;

      let decSub = 0;
      let decPurchased = 0;
      let decTrial = 0;

      if (params.action === "grant_included") {
        // "Included" means: subscription credits on Pro, trial credits on Free.
        if (pro) {
          incSub = amount;
          await WorkspaceCreditBalanceModel.updateOne(
            { workspaceId: orgId },
            { $inc: { subscriptionCreditsRemaining: amount } },
            { session },
          );
        } else {
          incTrial = amount;
          await WorkspaceCreditBalanceModel.updateOne(
            { workspaceId: orgId },
            { $inc: { trialCreditsRemaining: amount } },
            { session },
          );
        }
      } else if (params.action === "grant_on_demand") {
        // "On-demand credits" in the admin tool maps to the paid credit bucket (non-expiring).
        incPurchased = amount;
        await WorkspaceCreditBalanceModel.updateOne(
          { workspaceId: orgId },
          { $inc: { purchasedCreditsRemaining: amount } },
          { session },
        );
      } else if (params.action === "burn") {
        const total = sub + purchased + trial;
        if (amount > total) throw new Error(`Not enough credits to burn (${amount} requested, ${total} available)`);
        let remaining = amount;

        // Burn consumption order matches customer policy:
        // included → paid → (any leftover buckets).
        // included is subscription on Pro; trial on Free.
        if (pro) {
          decSub = Math.min(sub, remaining);
          remaining -= decSub;
          decPurchased = Math.min(purchased, remaining);
          remaining -= decPurchased;
          decTrial = Math.min(trial, remaining);
          remaining -= decTrial;
        } else {
          decTrial = Math.min(trial, remaining);
          remaining -= decTrial;
          decPurchased = Math.min(purchased, remaining);
          remaining -= decPurchased;
          decSub = Math.min(sub, remaining);
          remaining -= decSub;
        }

        await WorkspaceCreditBalanceModel.updateOne(
          { workspaceId: orgId },
          {
            $inc: {
              subscriptionCreditsRemaining: -decSub,
              purchasedCreditsRemaining: -decPurchased,
              trialCreditsRemaining: -decTrial,
            },
          },
          { session },
        );
      } else {
        throw new Error("Invalid action");
      }

      const actorUserId =
        params.actorUserId && Types.ObjectId.isValid(params.actorUserId) ? new Types.ObjectId(params.actorUserId) : null;

      const eventType =
        params.action === "grant_included"
          ? "admin_grant_included"
          : params.action === "grant_on_demand"
            ? "admin_grant_on_demand"
            : "admin_burn";

      await CreditLedgerModel.create(
        [
          {
            workspaceId: orgId,
            userId: actorUserId,
            docId: null,
            actionType: "unknown",
            qualityTier: "basic",
            status: "charged",
            eventType,
            cycleKey: null,
            cycleStart: null,
            cycleEnd: null,
            creditsEstimated: amount,
            creditsReserved: 0,
            creditsCharged: params.action === "burn" ? amount : 0,
            idempotencyKey: uuidKey(`admin:${eventType}:${workspaceId}`),
            requestId: null,
            stripeUsageReportedAt: null,
            creditsFromSubscription: incSub > 0 ? incSub : decSub > 0 ? decSub : 0,
            creditsFromPurchased: incPurchased > 0 ? incPurchased : decPurchased > 0 ? decPurchased : 0,
            creditsFromTrial: incTrial > 0 ? incTrial : decTrial > 0 ? decTrial : 0,
            creditsFromOnDemand: 0,
            adminReason: reason,
            adminActorEmail: params.actorEmail ? String(params.actorEmail).trim() : null,
          },
        ],
        { session },
      );
    });
  } finally {
    await session.endSession();
  }

  const snapshot = await getCreditsSnapshot({ workspaceId });
  return { ok: true, snapshot };
}

export async function adminSimulateNewBillingCycle(params: {
  workspaceId: string;
  newPeriodStartUnixSeconds: number;
  newPeriodEndUnixSeconds: number;
  reason: string;
  actorUserId: string | null;
  actorEmail: string | null;
}): Promise<{ ok: true; snapshot: CreditsSnapshot; cycleKey: string }> {
  const workspaceId = params.workspaceId;
  if (!Types.ObjectId.isValid(workspaceId)) throw new Error("Invalid workspaceId");
  const startUnix = asPositiveInt(params.newPeriodStartUnixSeconds, { max: 4_102_444_800 /* 2100-01-01 */ });
  const endUnix = asPositiveInt(params.newPeriodEndUnixSeconds, { max: 4_102_444_800 /* 2100-01-01 */ });
  if (!startUnix || !endUnix) throw new Error("newPeriodStartUnixSeconds and newPeriodEndUnixSeconds are required unix seconds");
  if (endUnix <= startUnix) throw new Error("newPeriodEndUnixSeconds must be > newPeriodStartUnixSeconds");
  const reason = nonEmptyString(params.reason);
  if (!reason) throw new Error("reason is required");

  await connectMongo();
  const orgId = new Types.ObjectId(workspaceId);

  const sub = await SubscriptionModel.findOne({ orgId, isDeleted: { $ne: true } })
    .select({ stripeSubscriptionId: 1 })
    .lean();
  const stripeSubscriptionId = typeof (sub as any)?.stripeSubscriptionId === "string" ? String((sub as any).stripeSubscriptionId) : "";
  if (!stripeSubscriptionId) throw new Error("Workspace has no stripeSubscriptionId; cannot simulate a billing cycle");

  const currentPeriodStart = new Date(startUnix * 1000);
  const currentPeriodEnd = new Date(endUnix * 1000);

  await SubscriptionModel.updateOne(
    { orgId, isDeleted: { $ne: true } },
    { $set: { currentPeriodStart, currentPeriodEnd } },
    { upsert: true },
  );

  const grant = await grantCycleIncludedCredits({
    workspaceId,
    stripeSubscriptionId,
    currentPeriodStart,
    currentPeriodEnd,
  });

  // Append-only admin audit row (non-mutating beyond the cycle grant above).
  const actorUserId =
    params.actorUserId && Types.ObjectId.isValid(params.actorUserId) ? new Types.ObjectId(params.actorUserId) : null;
  try {
    await CreditLedgerModel.create([
      {
        workspaceId: orgId,
        userId: actorUserId,
        docId: null,
        actionType: "unknown",
        qualityTier: "basic",
        status: "charged",
        eventType: "admin_simulate_cycle",
        cycleKey: grant.cycleKey,
        cycleStart: currentPeriodStart,
        cycleEnd: currentPeriodEnd,
        creditsEstimated: 0,
        creditsReserved: 0,
        creditsCharged: 0,
        idempotencyKey: `admin_simulate_cycle:${workspaceId}:${startUnix}`,
        requestId: null,
        stripeUsageReportedAt: null,
        adminReason: reason,
        adminActorEmail: params.actorEmail ? String(params.actorEmail).trim() : null,
      },
    ]);
  } catch (e) {
    const code = (e as any)?.code;
    if (code !== 11000) throw e;
  }

  const snapshot = await getCreditsSnapshot({ workspaceId });
  return { ok: true, snapshot, cycleKey: grant.cycleKey };
}


