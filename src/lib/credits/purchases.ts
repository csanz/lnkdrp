/**
 * Credit pack purchases: the grant when Stripe confirms payment, and the daily expiry of what is
 * left 12 months later. Pack definitions and the expiry arithmetic live in `packs.ts`.
 */
import mongoose, { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { CreditPurchaseModel } from "@/lib/models/CreditPurchase";
import { WorkspaceCreditBalanceModel } from "@/lib/models/WorkspaceCreditBalance";
import { defaultBalanceForWorkspace } from "@/lib/credits/creditService";
import { findCreditPack, planPurchaseExpiry, purchaseExpiresAt } from "@/lib/credits/packs";

function ledgerRow(params: { orgId: Types.ObjectId; userId: Types.ObjectId | null; eventType: string; credits: number; idempotencyKey: string }) {
  return {
    workspaceId: params.orgId,
    userId: params.userId,
    docId: null,
    actionType: "unknown",
    qualityTier: "basic",
    status: "charged",
    eventType: params.eventType,
    cycleKey: null,
    creditsEstimated: params.credits,
    creditsReserved: 0,
    creditsCharged: 0,
    idempotencyKey: params.idempotencyKey,
    requestId: null,
    stripeUsageReportedAt: null,
  };
}

/**
 * Add a paid pack's credits to the workspace, exactly once per Checkout session.
 *
 * - The balance row is created with the workspace's normal seed when it doesn't exist yet, so a
 *   Free workspace that buys before its first AI run still gets its starter credits.
 * - Buying turns off the Free daily brake (15 credits a day). The brake exists to stop free
 *   credits being farmed; throttling someone who just paid for 300 would defeat the purchase.
 *
 * Throws on an unknown pack or a paid amount that does not match the pack's price.
 */
export async function grantCreditPack(params: {
  orgId: string;
  userId: string | null;
  packId: string;
  checkoutSessionId: string;
  paymentIntentId: string | null;
  amountCents: number;
  /** Price recorded on the Checkout when it was created; falls back to the pack's current price. */
  expectedCents?: number | null;
  currency: string;
  purchasedAt: Date;
}): Promise<{ alreadyGranted: boolean; credits: number }> {
  const pack = findCreditPack(params.packId);
  if (!pack) throw new Error(`Unknown credit pack: ${params.packId}`);
  if (!Types.ObjectId.isValid(params.orgId)) throw new Error("Invalid orgId");
  const expected = typeof params.expectedCents === "number" && params.expectedCents > 0 ? params.expectedCents : pack.priceCents;
  if (params.amountCents !== expected) {
    throw new Error(`Paid amount ${params.amountCents} does not match ${pack.id} (${expected})`);
  }
  const orgId = new Types.ObjectId(params.orgId);
  const userId = params.userId && Types.ObjectId.isValid(params.userId) ? new Types.ObjectId(params.userId) : null;

  await connectMongo();
  const seed = await defaultBalanceForWorkspace(orgId);
  const { purchasedCreditsRemaining: _purchased, dailyCreditCap: _daily, ...seedRest } = seed;
  void _purchased;
  void _daily;

  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const existing = await CreditPurchaseModel.findOne({ stripeCheckoutSessionId: params.checkoutSessionId })
        .select({ _id: 1 })
        .session(session)
        .lean();
      if (existing) return { alreadyGranted: true, credits: pack.credits };

      await CreditPurchaseModel.create(
        [
          {
            orgId,
            userId,
            packId: pack.id,
            credits: pack.credits,
            amountCents: params.amountCents,
            currency: params.currency,
            stripeCheckoutSessionId: params.checkoutSessionId,
            stripePaymentIntentId: params.paymentIntentId,
            purchasedAt: params.purchasedAt,
            expiresAt: purchaseExpiresAt(params.purchasedAt),
          },
        ],
        { session },
      );
      await WorkspaceCreditBalanceModel.updateOne(
        { workspaceId: orgId },
        {
          $setOnInsert: { workspaceId: orgId, ...seedRest },
          $inc: { purchasedCreditsRemaining: pack.credits },
          $set: { dailyCreditCap: null },
        },
        { upsert: true, session },
      );
      await CreditLedgerModel.create(
        [ledgerRow({ orgId, userId, eventType: "credit_pack_purchase", credits: pack.credits, idempotencyKey: `credit_pack:${params.checkoutSessionId}` })],
        { session },
      );
      return { alreadyGranted: false, credits: pack.credits };
    });
  } catch (e) {
    // A concurrent delivery of the same session won the unique index.
    if ((e as { code?: unknown })?.code === 11000) return { alreadyGranted: true, credits: pack.credits };
    throw e;
  } finally {
    await session.endSession();
  }
}

/**
 * Take back the unspent credits of every purchase whose 12 months are up.
 *
 * One transaction per workspace: it reads the live purchases and the purchased-credits counter,
 * works out each due purchase's unspent part (`planPurchaseExpiry`), marks those purchases expired
 * and lowers the counter. A concurrent AI run conflicts with the transaction and it retries, so the
 * counter never goes negative. Safe to re-run: expired purchases are skipped.
 */
export async function expireCreditPurchases(params: { now?: Date; limit?: number } = {}): Promise<{
  workspaces: number;
  purchasesExpired: number;
  creditsExpired: number;
}> {
  const now = params.now ?? new Date();
  const limit = Math.max(1, Math.min(1000, Math.floor(params.limit ?? 200)));
  await connectMongo();
  const orgIds = (await CreditPurchaseModel.distinct("orgId", { expiredAt: null, expiresAt: { $lte: now } })).slice(0, limit) as unknown as Types.ObjectId[];

  let purchasesExpired = 0;
  let creditsExpired = 0;
  for (const orgId of orgIds) {
    const session = await mongoose.startSession();
    try {
      const res = await session.withTransaction(async () => {
        const lots = (await CreditPurchaseModel.find({ orgId, expiredAt: null })
          .select({ _id: 1, credits: 1, purchasedAt: 1, expiresAt: 1 })
          .session(session)
          .lean()) as Array<{ _id: Types.ObjectId; credits: number; purchasedAt: Date; expiresAt: Date }>;
        const bal = (await WorkspaceCreditBalanceModel.findOne({ workspaceId: orgId })
          .select({ purchasedCreditsRemaining: 1 })
          .session(session)
          .lean()) as { purchasedCreditsRemaining?: number } | null;
        const plan = planPurchaseExpiry({
          remaining: Number(bal?.purchasedCreditsRemaining ?? 0) || 0,
          lots: lots.map((l) => ({ id: String(l._id), credits: l.credits, purchasedAt: l.purchasedAt, expiresAt: l.expiresAt })),
          now,
        });
        const total = plan.expire.reduce((s, e) => s + e.credits, 0);
        for (const e of plan.expire) {
          await CreditPurchaseModel.updateOne(
            { _id: new Types.ObjectId(e.id), expiredAt: null },
            { $set: { expiredAt: now, creditsExpired: e.credits } },
            { session },
          );
          if (e.credits > 0) {
            await CreditLedgerModel.create(
              [ledgerRow({ orgId, userId: null, eventType: "credit_pack_expired", credits: e.credits, idempotencyKey: `credit_pack_expired:${e.id}` })],
              { session },
            );
          }
        }
        if (total > 0 && bal) {
          await WorkspaceCreditBalanceModel.updateOne(
            { workspaceId: orgId },
            { $set: { purchasedCreditsRemaining: plan.remainingAfter } },
            { session },
          );
        }
        return { count: plan.expire.length, total };
      });
      purchasesExpired += res.count;
      creditsExpired += res.total;
    } finally {
      await session.endSession();
    }
  }
  return { workspaces: orgIds.length, purchasesExpired, creditsExpired };
}
