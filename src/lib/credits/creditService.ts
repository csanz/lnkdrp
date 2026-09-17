import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { OrgModel } from "@/lib/models/Org";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { FREE_STARTER_CREDITS } from "@/lib/credits/grants";
import { createCreditService } from "@/lib/credits/serviceCore";
import { createMongooseCreditStore } from "@/lib/credits/mongooseStore";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { isProSubscription } from "@/lib/billing/subscriptionState";
import type { ActionType, LedgerStatus, QualityTier } from "@/lib/credits/types";
import type { WorkspaceBalanceSnapshot } from "@/lib/credits/store";

/** Daily credit brake for Free workspaces (credits per UTC day). Pro has no daily cap. */
export const FREE_DAILY_CREDIT_CAP = 15;

/** The two facts every seed decision depends on: is this a personal org, and is it paid. */
type WorkspacePlanFacts = { isPersonal: boolean; isPro: boolean };

/** Coerce a string/ObjectId workspace id; throws on malformed input. */
function toOrgObjectId(orgId: string | Types.ObjectId): Types.ObjectId {
  if (orgId instanceof Types.ObjectId) return orgId;
  const s = String(orgId).trim();
  if (!Types.ObjectId.isValid(s)) throw new Error("Invalid workspaceId");
  return new Types.ObjectId(s);
}

/**
 * Read org type + subscription status/kind in one round trip (the only DB reads a seed needs).
 *
 * `isPro` uses `isProSubscription`, not merely "is there a billable subscription": a personal Free
 * workspace that added a card for pay-as-you-go is billable but still Free, and if its balance row
 * had not been seeded yet it must still receive the 50-credit starter grant and the daily brake —
 * pay-as-you-go is what a Free workspace does *after* the starter grant, not a Pro substitute.
 */
async function workspacePlanFacts(orgId: Types.ObjectId): Promise<WorkspacePlanFacts> {
  const [org, sub] = await Promise.all([
    OrgModel.findOne({ _id: orgId, isDeleted: { $ne: true } }).select({ type: 1 }).lean(),
    SubscriptionModel.findOne({ orgId, isDeleted: { $ne: true } }).select({ status: 1, kind: 1 }).lean(),
  ]);
  return {
    isPersonal: (org as { type?: unknown } | null)?.type === "personal",
    isPro: isProSubscription(sub as { status?: unknown; kind?: unknown } | null),
  };
}

/** Pure form of the starter-grant rule: any workspace not on Pro → `FREE_STARTER_CREDITS`, else 0. */
function starterCreditsFromFacts(facts: WorkspacePlanFacts): number {
  if (FREE_STARTER_CREDITS <= 0) return 0;
  return !facts.isPro ? FREE_STARTER_CREDITS : 0;
}

/** Pure form of the daily brake: Free → `FREE_DAILY_CREDIT_CAP`, Pro → no cap. */
function dailyCreditCapFromFacts(facts: WorkspacePlanFacts): number | null {
  return facts.isPro ? null : FREE_DAILY_CREDIT_CAP;
}

/**
 * Decide whether a workspace qualifies for the one-time Free starter grant.
 *
 * Every workspace that is not on Pro qualifies, personal or team (decided 2026-09-17: a new team
 * workspace is a separate customer with its own plan, and starting it at 0 made it open on an
 * "AI tools are unavailable" banner). The Free daily brake bounds how fast starter credits can be
 * spent. Returns the credits to seed, or 0.
 *
 * This is the single source of truth for the grant: both the reserve path
 * (`defaultBalanceForWorkspace`) and the dashboard snapshot (`getCreditsSnapshot`) seed through it,
 * so whichever runs first creates the row and the other finds it (the grant lands exactly once).
 * Side effects: reads the org type and subscription status; skipped entirely when
 * `FREE_STARTER_CREDITS` is 0 (credits are a Pro concept, so Free gets none).
 */
export async function starterCreditsForWorkspace(orgId: string | Types.ObjectId): Promise<number> {
  if (FREE_STARTER_CREDITS <= 0) return 0;
  return starterCreditsFromFacts(await workspacePlanFacts(toOrgObjectId(orgId)));
}

/**
 * Default balance for a workspace that has no balance row yet.
 *
 * Exists so the credit service can operate even before a workspace has ever run an AI action.
 * Every bucket starts at 0; the only exception is the Free starter grant (`FREE_STARTER_CREDITS`,
 * 50, granted once to every non-Pro workspace, see `starterCreditsForWorkspace`). Free workspaces
 * (personal or team) also get the daily brake (`FREE_DAILY_CREDIT_CAP`); Pro has none. Pro included
 * credits arrive via `grantCycleIncludedCredits` when Stripe opens a billing cycle. The seed is
 * idempotent because callers only write it when no balance row exists yet (`create` inside the
 * reserve transaction, `$setOnInsert` in the snapshot).
 */
export async function defaultBalanceForWorkspace(orgId: string | Types.ObjectId): Promise<WorkspaceBalanceSnapshot> {
  const facts = await workspacePlanFacts(toOrgObjectId(orgId));
  return {
    trialCreditsRemaining: starterCreditsFromFacts(facts),
    subscriptionCreditsRemaining: 0,
    purchasedCreditsRemaining: 0,
    onDemandEnabled: false,
    onDemandMonthlyLimitCents: 0,
    dailyCreditCap: dailyCreditCapFromFacts(facts),
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
    initBalanceIfMissing: async () => await defaultBalanceForWorkspace(params.workspaceId),
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

/**
 * Records an AI run that was performed for the workspace but must not be billed to it.
 *
 * Exists for recipient uploads (request/replace links): the automatic summary still runs so the
 * owner gets a summarized document, but the owner never pays for a stranger's upload. The row
 * carries `source: "recipient"` and 0 credits, touches no balance bucket, and is idempotent on
 * `idempotencyKey` (a retried job returns the existing row).
 * Errors: throws on invalid ids; DB failures propagate.
 */
export async function recordUnbilledRun(params: {
  workspaceId: string;
  userId: string;
  docId?: string | null;
  actionType: ActionType;
  qualityTier: QualityTier;
  idempotencyKey: string;
  source: "recipient" | "agent";
}): Promise<{ ledgerId: string; created: boolean }> {
  if (!Types.ObjectId.isValid(params.workspaceId)) throw new Error("Invalid workspaceId");
  if (!Types.ObjectId.isValid(params.userId)) throw new Error("Invalid userId");
  if (params.docId && !Types.ObjectId.isValid(params.docId)) throw new Error("Invalid docId");
  const idempotencyKey = (params.idempotencyKey ?? "").trim();
  if (!idempotencyKey) throw new Error("Missing idempotencyKey");

  await connectMongo();
  const workspaceId = new Types.ObjectId(params.workspaceId);
  const existing = await CreditLedgerModel.findOne({ workspaceId, idempotencyKey }).select({ _id: 1 }).lean();
  if (existing) return { ledgerId: String(existing._id), created: false };
  const created = await CreditLedgerModel.create({
    workspaceId,
    userId: new Types.ObjectId(params.userId),
    docId: params.docId ? new Types.ObjectId(params.docId) : null,
    actionType: params.actionType,
    qualityTier: params.qualityTier,
    status: "charged",
    source: params.source,
    idempotencyKey,
    creditsEstimated: 0,
    creditsReserved: 0,
    creditsCharged: 0,
  });
  return { ledgerId: String(created._id), created: true };
}
