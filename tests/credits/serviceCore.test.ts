import { describe, expect, test } from "vitest";

import { createCreditService } from "@/lib/credits/serviceCore";
import type { CreditStore, WorkspaceBalanceSnapshot } from "@/lib/credits/store";

function makeStore(init: { balance: WorkspaceBalanceSnapshot; usage?: { daily?: number; cycle?: number; onDemand?: number } }) {
  let balance = { ...init.balance };
  const ledgersByIdempotency = new Map<string, { id: string; status: any; creditsReserved: number; creditsEstimated: number }>();
  const ledgersById = new Map<
    string,
    {
      id: string;
      workspaceId: string;
      userId: string;
      docId: string | null;
      actionType: any;
      qualityTier: any;
      status: any;
      creditsReserved: number;
      creditsEstimated: number;
      creditsFrom: any;
    }
  >();
  let nextId = 1;

  const store: CreditStore = {
    async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
      return await fn();
    },

    async getLedgerByIdempotencyKey({ idempotencyKey }) {
      const v = ledgersByIdempotency.get(idempotencyKey);
      return v ? { ...v } : null;
    },

    async createPendingLedger(args) {
      const id = String(nextId++);
      ledgersByIdempotency.set(args.idempotencyKey, {
        id,
        status: "pending",
        creditsReserved: args.creditsReserved,
        creditsEstimated: args.creditsEstimated,
      });
      ledgersById.set(id, {
        id,
        workspaceId: args.workspaceId,
        userId: args.userId,
        docId: args.docId,
        actionType: args.actionType,
        qualityTier: args.qualityTier,
        status: "pending",
        creditsReserved: args.creditsReserved,
        creditsEstimated: args.creditsEstimated,
        creditsFrom: args.creditsFrom,
      });
      return { id };
    },

    async getOrCreateBalance({ initIfMissing }) {
      if (!balance) balance = await initIfMissing();
      return { ...balance };
    },

    async saveBalance({ next }) {
      balance = { ...next };
    },

    async getUsageSums() {
      return {
        dailyReserved: init.usage?.daily ?? 0,
        monthlyReserved: init.usage?.cycle ?? 0,
        monthlyOnDemandReserved: init.usage?.onDemand ?? 0,
      };
    },

    async getLedgerById({ ledgerId }) {
      const v = ledgersById.get(ledgerId);
      return v
        ? {
            id: v.id,
            status: v.status,
            creditsReserved: v.creditsReserved,
            creditsEstimated: v.creditsEstimated,
            workspaceId: v.workspaceId,
            userId: v.userId,
            docId: v.docId,
            actionType: v.actionType,
            qualityTier: v.qualityTier,
            creditsFrom: v.creditsFrom,
          }
        : null;
    },

    async setLedgerStatus({ ledgerId, status, creditsCharged }) {
      const v = ledgersById.get(ledgerId);
      if (!v) return;
      v.status = status;
      if (typeof creditsCharged === "number") {
        // not needed by these tests
        void creditsCharged;
      }
    },
  };

  return {
    store,
    getBalance: () => ({ ...balance }),
    getLedger: (idKey: string) => ledgersByIdempotency.get(idKey),
    getLedgerFullById: (id: string) => ledgersById.get(id),
  };
}

function baseBalance(): WorkspaceBalanceSnapshot {
  return {
    trialCreditsRemaining: 0,
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

describe("credits/serviceCore", () => {
  test("consumes included subscription credits before trial/purchased", async () => {
    const { store, getLedgerFullById, getBalance } = makeStore({
      balance: {
        ...baseBalance(),
        trialCreditsRemaining: 50,
        subscriptionCreditsRemaining: 300,
        purchasedCreditsRemaining: 10,
      },
    });
    const svc = createCreditService(store);

    const res = await svc.reserveCreditsOrThrow({
      workspaceId: "w1",
      userId: "u1",
      docId: null,
      actionType: "summary",
      qualityTier: "basic",
      idempotencyKey: "k1",
      initBalanceIfMissing: async () => baseBalance(),
    });

    const full = getLedgerFullById(res.ledgerId)!;
    expect(full.creditsFrom.subscription).toBe(1);
    expect(full.creditsFrom.trial).toBe(0);
    expect(full.creditsFrom.purchased).toBe(0);
    expect(getBalance().subscriptionCreditsRemaining).toBe(299);
  });

  test("idempotency: second reserve with same key does not double-decrement", async () => {
    const { store, getBalance } = makeStore({
      balance: { ...baseBalance(), subscriptionCreditsRemaining: 300 },
    });
    const svc = createCreditService(store);

    await svc.reserveCreditsOrThrow({
      workspaceId: "w1",
      userId: "u1",
      docId: null,
      actionType: "summary",
      qualityTier: "basic",
      idempotencyKey: "k1",
      initBalanceIfMissing: async () => baseBalance(),
    });
    await svc.reserveCreditsOrThrow({
      workspaceId: "w1",
      userId: "u1",
      docId: null,
      actionType: "summary",
      qualityTier: "basic",
      idempotencyKey: "k1",
      initBalanceIfMissing: async () => baseBalance(),
    });

    expect(getBalance().subscriptionCreditsRemaining).toBe(299);
  });

  test("blocks when insufficient credits and on-demand disabled", async () => {
    const { store } = makeStore({
      balance: { ...baseBalance(), subscriptionCreditsRemaining: 0, purchasedCreditsRemaining: 0, trialCreditsRemaining: 0 },
    });
    const svc = createCreditService(store);

    await expect(
      svc.reserveCreditsOrThrow({
        workspaceId: "w1",
        userId: "u1",
        docId: null,
        actionType: "history",
        qualityTier: "advanced",
        idempotencyKey: "k1",
        initBalanceIfMissing: async () => baseBalance(),
      }),
    ).rejects.toThrow(/Insufficient credits/i);
  });

  test("enforces on-demand monthly limit against on-demand portion (cycle window)", async () => {
    const { store } = makeStore({
      balance: { ...baseBalance(), onDemandEnabled: true, onDemandMonthlyLimitCents: 20 }, // 2 credits max
      usage: { onDemand: 1 }, // already reserved 1 on-demand credit in this cycle
    });
    const svc = createCreditService(store);

    await expect(
      svc.reserveCreditsOrThrow({
        workspaceId: "w1",
        userId: "u1",
        docId: null,
        idempotencyKey: "k1",
        actionType: "review",
        qualityTier: "standard", // fixed schedule: 5 credits
        initBalanceIfMissing: async () => baseBalance(),
      }),
    ).rejects.toThrow(/On-demand monthly limit exceeded/i);
  });
});


