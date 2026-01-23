import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { createCreditService } from "@/lib/credits/serviceCore";
import { createMongooseCreditStore } from "@/lib/credits/mongooseStore";
import type { ActionType, LedgerStatus, QualityTier } from "@/lib/credits/types";
import type { WorkspaceBalanceSnapshot } from "@/lib/credits/store";

/**
 * Returns true when a Stripe subscription status should be treated as "pro".
 *
 * Exists to decide whether a workspace gets trial credits as a starter balance.
 */
function isProSubscriptionStatus(statusRaw: unknown): boolean {
  const s = typeof statusRaw === "string" ? statusRaw.trim().toLowerCase() : "";
  return s === "active" || s === "trialing";
}

/**
 * Default initializer for a missing workspace balance snapshot.
 *
 * Exists so the credit service can operate even before a workspace has ever run an AI action.
 * Side effects: reads subscription status to decide whether to include one-time trial credits.
 */
async function defaultInitBalanceIfMissing(params: { workspaceId: string }): Promise<WorkspaceBalanceSnapshot> {
  const orgId = new Types.ObjectId(params.workspaceId);
  const sub = await SubscriptionModel.findOne({ orgId, isDeleted: { $ne: true } }).select({ status: 1 }).lean();
  const isPro = isProSubscriptionStatus((sub as any)?.status);
  return {
    // Free "trial" credits are one-time starter credits.
    trialCreditsRemaining: isPro ? 0 : 50,
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
}

/**
 * Reserves credits for an AI action and returns the created/updated ledger entry info.
 *
 * Exists as the main "charge gate" for AI runs: enforces caps, creates idempotent ledger rows,
 * and prevents work from starting when a workspace is out of credits.
 * Errors: throws on invalid IDs or when reservation fails (e.g. insufficient credits).
 */
export async function reserveCreditsOrThrow(params: {
  workspaceId: string;
  userId: string;
  docId?: string | null;
  actionType: ActionType;
  qualityTier: QualityTier;
  idempotencyKey: string;
  requestId?: string | null;
}): Promise<{
  ledgerId: string;
  status: LedgerStatus;
  creditsReserved: number;
  creditsEstimated: number;
}> {
  if (!Types.ObjectId.isValid(params.workspaceId)) throw new Error("Invalid workspaceId");
  if (!Types.ObjectId.isValid(params.userId)) throw new Error("Invalid userId");
  if (params.docId && !Types.ObjectId.isValid(params.docId)) throw new Error("Invalid docId");

  await connectMongo();
  const store = createMongooseCreditStore({ workspaceId: params.workspaceId });
  const svc = createCreditService(store);
  return await svc.reserveCreditsOrThrow({
    ...params,
    initBalanceIfMissing: async () => await defaultInitBalanceIfMissing({ workspaceId: params.workspaceId }),
  });
}

/**
 * Marks a reserved ledger entry as charged (finalizes credits and records telemetry).
 *
 * Exists to separate reservation (before the AI run) from final charge (after completion).
 * Side effects: runs within a DB transaction (best-effort) to keep balances consistent.
 */
export async function markLedgerCharged(params: {
  workspaceId: string;
  ledgerId: string;
  creditsCharged: number;
  telemetry?: Record<string, unknown> | null;
}): Promise<void> {
  if (!Types.ObjectId.isValid(params.workspaceId)) return;
  await connectMongo();
  const store = createMongooseCreditStore({ workspaceId: params.workspaceId });
  const svc = createCreditService(store);
  await store.withTransaction(async () => {
    await svc.markLedgerCharged({ ledgerId: params.ledgerId, creditsCharged: params.creditsCharged, telemetry: params.telemetry ?? null });
  });
}

/**
 * Marks a ledger entry as failed and refunds reserved credits back to the workspace.
 *
 * Exists to ensure user-visible failures do not permanently consume credits.
 * Errors: no-ops on invalid workspace id; otherwise may throw on DB failures.
 */
export async function failAndRefundLedger(params: { workspaceId: string; ledgerId: string }): Promise<void> {
  if (!Types.ObjectId.isValid(params.workspaceId)) return;
  await connectMongo();
  const store = createMongooseCreditStore({ workspaceId: params.workspaceId });
  const svc = createCreditService(store);
  await svc.failAndRefundLedger({ ledgerId: params.ledgerId });
}


