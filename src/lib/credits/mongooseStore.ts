import mongoose, { Types } from "mongoose";

import type { CreditStore, CreditsUsageSums, WorkspaceBalanceSnapshot } from "@/lib/credits/store";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { WorkspaceCreditBalanceModel } from "@/lib/models/WorkspaceCreditBalance";
import { UsageAggDailyModel } from "@/lib/models/UsageAggDaily";
import { UsageAggCycleModel } from "@/lib/models/UsageAggCycle";

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

function clampNonNegInt(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

function snapshotBalance(doc: any, now: Date): WorkspaceBalanceSnapshot {
  const periodStart = doc?.currentPeriodStart instanceof Date ? doc.currentPeriodStart : null;
  const periodEnd = doc?.currentPeriodEnd instanceof Date ? doc.currentPeriodEnd : null;
  return {
    trialCreditsRemaining: clampNonNegInt(doc?.trialCreditsRemaining ?? 0),
    subscriptionCreditsRemaining:
      periodEnd && now.getTime() > periodEnd.getTime() ? 0 : clampNonNegInt(doc?.subscriptionCreditsRemaining ?? 0),
    purchasedCreditsRemaining: clampNonNegInt(doc?.purchasedCreditsRemaining ?? 0),
    onDemandEnabled: Boolean(doc?.onDemandEnabled),
    onDemandMonthlyLimitCents: clampNonNegInt(doc?.onDemandMonthlyLimitCents ?? 0),
    dailyCreditCap:
      typeof doc?.dailyCreditCap === "number" && Number.isFinite(doc.dailyCreditCap) ? clampNonNegInt(doc.dailyCreditCap) : null,
    monthlyCreditCap:
      typeof doc?.monthlyCreditCap === "number" && Number.isFinite(doc.monthlyCreditCap) ? clampNonNegInt(doc.monthlyCreditCap) : null,
    perRunCreditCapBasic: clampNonNegInt(doc?.perRunCreditCapBasic ?? 20),
    perRunCreditCapStandard: clampNonNegInt(doc?.perRunCreditCapStandard ?? 60),
    perRunCreditCapAdvanced: clampNonNegInt(doc?.perRunCreditCapAdvanced ?? 150),
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
  };
}

export function createMongooseCreditStore(params: { workspaceId: string }): CreditStore {
  const workspaceId = params.workspaceId;
  if (!Types.ObjectId.isValid(workspaceId)) throw new Error("Invalid workspaceId");
  const orgId = new Types.ObjectId(workspaceId);

  let session: mongoose.ClientSession | null = null;

  function mustSession(): mongoose.ClientSession {
    if (!session) throw new Error("Missing transaction session");
    return session;
  }

  return {
    async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
      const s = await mongoose.startSession();
      session = s;
      try {
        return await s.withTransaction(async () => await fn());
      } finally {
        session = null;
        await s.endSession();
      }
    },

    async getLedgerByIdempotencyKey({ idempotencyKey }): Promise<any> {
      const s = mustSession();
      const existing = await CreditLedgerModel.findOne({ workspaceId: orgId, idempotencyKey })
        .select({ _id: 1, status: 1, creditsReserved: 1, creditsEstimated: 1 })
        .session(s)
        .lean();
      if (!existing?._id) return null;
      return {
        id: String(existing._id),
        status: (existing as any).status ?? "pending",
        creditsReserved: clampNonNegInt((existing as any).creditsReserved ?? 0),
        creditsEstimated: clampNonNegInt((existing as any).creditsEstimated ?? 0),
      };
    },

    async createPendingLedger(args): Promise<{ id: string }> {
      const s = mustSession();
      const created = await CreditLedgerModel.create(
        [
          {
            workspaceId: orgId,
            userId: new Types.ObjectId(args.userId),
            docId: args.docId ? new Types.ObjectId(args.docId) : null,
            actionType: args.actionType,
            qualityTier: args.qualityTier,
            status: "pending",
            creditsEstimated: args.creditsEstimated,
            creditsReserved: args.creditsReserved,
            creditsCharged: 0,
            requestId: args.requestId ?? null,
            idempotencyKey: args.idempotencyKey,
            stripeUsageReportedAt: null,
            costUnitsActual: null,
            costUsdActual: null,
            cycleKey: args.cycleKey,
            cycleStart: args.cycleStart,
            cycleEnd: args.cycleEnd ?? null,
            usageAggAppliedAt: null,
            creditsFromTrial: args.creditsFrom.trial,
            creditsFromSubscription: args.creditsFrom.subscription,
            creditsFromPurchased: args.creditsFrom.purchased,
            creditsFromOnDemand: args.creditsFrom.on_demand,
          },
        ],
        { session: s },
      );
      return { id: String(created[0]!._id) };
    },

    async getOrCreateBalance({ initIfMissing }): Promise<WorkspaceBalanceSnapshot> {
      const s = mustSession();
      const now = new Date();
      const found = await WorkspaceCreditBalanceModel.findOne({ workspaceId: orgId }).session(s);
      if (found) return snapshotBalance(found, now);
      const init = await initIfMissing();
      const created = await WorkspaceCreditBalanceModel.create(
        [
          {
            workspaceId: orgId,
            trialCreditsRemaining: init.trialCreditsRemaining,
            subscriptionCreditsRemaining: init.subscriptionCreditsRemaining,
            purchasedCreditsRemaining: init.purchasedCreditsRemaining,
            onDemandEnabled: init.onDemandEnabled,
            onDemandMonthlyLimitCents: init.onDemandMonthlyLimitCents,
            dailyCreditCap: init.dailyCreditCap,
            monthlyCreditCap: init.monthlyCreditCap,
            perRunCreditCapBasic: init.perRunCreditCapBasic,
            perRunCreditCapStandard: init.perRunCreditCapStandard,
            perRunCreditCapAdvanced: init.perRunCreditCapAdvanced,
            currentPeriodStart: init.currentPeriodStart ?? null,
            currentPeriodEnd: init.currentPeriodEnd ?? null,
          },
        ],
        { session: s },
      );
      return snapshotBalance(created[0], now);
    },

    async saveBalance({ next }): Promise<void> {
      const s = mustSession();
      await WorkspaceCreditBalanceModel.updateOne(
        { workspaceId: orgId },
        {
          $set: {
            trialCreditsRemaining: clampNonNegInt(next.trialCreditsRemaining),
            subscriptionCreditsRemaining: clampNonNegInt(next.subscriptionCreditsRemaining),
            purchasedCreditsRemaining: clampNonNegInt(next.purchasedCreditsRemaining),
            onDemandEnabled: Boolean(next.onDemandEnabled),
            onDemandMonthlyLimitCents: clampNonNegInt(next.onDemandMonthlyLimitCents),
            dailyCreditCap: next.dailyCreditCap === null ? null : clampNonNegInt(next.dailyCreditCap),
            monthlyCreditCap: next.monthlyCreditCap === null ? null : clampNonNegInt(next.monthlyCreditCap),
            perRunCreditCapBasic: clampNonNegInt(next.perRunCreditCapBasic),
            perRunCreditCapStandard: clampNonNegInt(next.perRunCreditCapStandard),
            perRunCreditCapAdvanced: clampNonNegInt(next.perRunCreditCapAdvanced),
            currentPeriodStart: next.currentPeriodStart ?? null,
            currentPeriodEnd: next.currentPeriodEnd ?? null,
          },
        },
        { upsert: true, session: s },
      );
    },

    async getUsageSums({ now, cycleStart }): Promise<CreditsUsageSums> {
      const s = mustSession();
      const dayStart = startOfUtcDay(now);
      const windowStart = cycleStart instanceof Date && Number.isFinite(cycleStart.getTime()) ? cycleStart : startOfUtcMonth(now);

      const matchBase = { workspaceId: orgId, status: { $in: ["pending", "charged"] } };
      const [dailyAgg, monthlyAgg, onDemandAgg] = await Promise.all([
        CreditLedgerModel.aggregate([
          { $match: { ...matchBase, createdDate: { $gte: dayStart } } },
          { $group: { _id: null, sum: { $sum: "$creditsReserved" } } },
        ]).session(s),
        CreditLedgerModel.aggregate([
          { $match: { ...matchBase, createdDate: { $gte: windowStart } } },
          { $group: { _id: null, sum: { $sum: "$creditsReserved" } } },
        ]).session(s),
        CreditLedgerModel.aggregate([
          {
            $match: {
              ...matchBase,
              createdDate: { $gte: windowStart },
              creditsFromOnDemand: { $gt: 0 },
            },
          },
          { $group: { _id: null, sum: { $sum: "$creditsFromOnDemand" } } },
        ]).session(s),
      ]);

      return {
        dailyReserved: clampNonNegInt((dailyAgg as any)?.[0]?.sum ?? 0),
        monthlyReserved: clampNonNegInt((monthlyAgg as any)?.[0]?.sum ?? 0),
        monthlyOnDemandReserved: clampNonNegInt((onDemandAgg as any)?.[0]?.sum ?? 0),
      };
    },

    async getLedgerById({ ledgerId }): Promise<any> {
      const s = mustSession();
      if (!Types.ObjectId.isValid(ledgerId)) return null;
      const l = await CreditLedgerModel.findById(ledgerId)
        .select({
          _id: 1,
          workspaceId: 1,
          userId: 1,
          docId: 1,
          actionType: 1,
          qualityTier: 1,
          status: 1,
          creditsReserved: 1,
          creditsEstimated: 1,
          creditsFromTrial: 1,
          creditsFromSubscription: 1,
          creditsFromPurchased: 1,
          creditsFromOnDemand: 1,
        })
        .session(s)
        .lean();
      if (!l?._id) return null;
      return {
        id: String(l._id),
        workspaceId: String(l.workspaceId),
        userId: String(l.userId),
        docId: l.docId ? String(l.docId) : null,
        actionType: (l as any).actionType,
        qualityTier: (l as any).qualityTier,
        status: (l as any).status ?? "pending",
        creditsReserved: clampNonNegInt((l as any).creditsReserved ?? 0),
        creditsEstimated: clampNonNegInt((l as any).creditsEstimated ?? 0),
        creditsFrom: {
          trial: clampNonNegInt((l as any).creditsFromTrial ?? 0),
          subscription: clampNonNegInt((l as any).creditsFromSubscription ?? 0),
          purchased: clampNonNegInt((l as any).creditsFromPurchased ?? 0),
          on_demand: clampNonNegInt((l as any).creditsFromOnDemand ?? 0),
        },
      };
    },

    async setLedgerStatus({ ledgerId, status, creditsCharged, telemetry }): Promise<void> {
      const s = mustSession();
      if (!Types.ObjectId.isValid(ledgerId)) return;
      const nextCreditsCharged = typeof creditsCharged === "number" ? clampNonNegInt(creditsCharged) : null;
      const update: Record<string, unknown> = { status };
      if (nextCreditsCharged !== null) update.creditsCharged = nextCreditsCharged;
      if (telemetry && typeof telemetry === "object") {
        Object.assign(update, telemetry);
      }

      // Fast path: non-charged status updates don't need aggregate work.
      if (status !== "charged") {
        await CreditLedgerModel.updateOne({ _id: new Types.ObjectId(ledgerId) }, { $set: update }, { session: s });
        return;
      }

      // Claim the ledger for aggregate application exactly once (concurrency-safe).
      // If this doesn't match, someone already applied aggregates (or this isn't an ai_run row).
      const claimed = await CreditLedgerModel.findOneAndUpdate(
        {
          _id: new Types.ObjectId(ledgerId),
          eventType: "ai_run",
          usageAggAppliedAt: null,
        },
        { $set: { ...update, usageAggAppliedAt: new Date(0) } },
        {
          session: s,
          new: true,
          projection: {
            _id: 1,
            cycleKey: 1,
            cycleStart: 1,
            cycleEnd: 1,
            creditsFromTrial: 1,
            creditsFromSubscription: 1,
            creditsFromPurchased: 1,
            creditsFromOnDemand: 1,
            costUsdActual: 1,
            createdDate: 1,
          },
        } as any,
      ).lean();

      if (!claimed?._id) {
        // Still persist status/telemetry/creditsCharged (but don't touch aggregates).
        await CreditLedgerModel.updateOne({ _id: new Types.ObjectId(ledgerId) }, { $set: update }, { session: s });
        return;
      }

      const createdAt = (claimed as any)?.createdDate instanceof Date ? (claimed as any).createdDate : new Date();
      const day = createdAt.toISOString().slice(0, 10); // UTC day key
      const cycleKey = typeof (claimed as any)?.cycleKey === "string" ? String((claimed as any).cycleKey) : "";
      const cycleStart = (claimed as any)?.cycleStart instanceof Date ? (claimed as any).cycleStart : null;
      const cycleEnd = (claimed as any)?.cycleEnd instanceof Date ? (claimed as any).cycleEnd : null;

      const fromTrial = clampNonNegInt((claimed as any)?.creditsFromTrial ?? 0);
      const fromSub = clampNonNegInt((claimed as any)?.creditsFromSubscription ?? 0);
      const fromPurchased = clampNonNegInt((claimed as any)?.creditsFromPurchased ?? 0);
      const fromOnDemand = clampNonNegInt((claimed as any)?.creditsFromOnDemand ?? 0);
      const included = fromTrial + fromSub;
      const paid = fromPurchased + fromOnDemand;
      const total = nextCreditsCharged !== null ? nextCreditsCharged : included + paid;

      const costUsd = typeof (claimed as any)?.costUsdActual === "number" ? (claimed as any).costUsdActual : 0;

      await UsageAggDailyModel.updateOne(
        { workspaceId: orgId, day },
        {
          $setOnInsert: { workspaceId: orgId, day },
          $inc: {
            includedUsedCredits: included,
            paidUsedCredits: paid,
            totalUsedCredits: total,
            onDemandUsedCredits: fromOnDemand,
            costUsdActual: typeof costUsd === "number" && Number.isFinite(costUsd) ? Math.max(0, costUsd) : 0,
            runs: 1,
          },
        },
        { upsert: true, session: s },
      );

      if (cycleKey) {
        await UsageAggCycleModel.updateOne(
          { workspaceId: orgId, cycleKey },
          {
            $setOnInsert: { workspaceId: orgId, cycleKey, cycleStart: cycleStart ?? null, cycleEnd: cycleEnd ?? null },
            $set: { ...(cycleEnd ? { cycleEnd } : {}) },
            $inc: {
              includedUsedCredits: included,
              paidUsedCredits: paid,
              totalUsedCredits: total,
              onDemandUsedCredits: fromOnDemand,
              costUsdActual: typeof costUsd === "number" && Number.isFinite(costUsd) ? Math.max(0, costUsd) : 0,
              runs: 1,
            },
          },
          { upsert: true, session: s },
        );
      }

      // Finalize appliedAt marker (overwrite the sentinel).
      await CreditLedgerModel.updateOne(
        { _id: new Types.ObjectId(ledgerId) },
        { $set: { usageAggAppliedAt: new Date() } },
        { session: s },
      );
    },
  };
}


