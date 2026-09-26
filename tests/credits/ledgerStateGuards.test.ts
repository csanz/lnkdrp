import { describe, expect, test } from "vitest";

import { createCreditService } from "@/lib/credits/serviceCore";
import type { CreditStore, LedgerTransition, WorkspaceBalanceSnapshot } from "@/lib/credits/store";
import type { LedgerStatus } from "@/lib/credits/types";

/**
 * A ledger row moves along two legal edges and no others: pending -> charged, and pending ->
 * failed or refunded. Everything else is a replay and must be a no-op.
 *
 * The defect these tests pin: the settle path used to flip a row to `charged` without looking at
 * its status, and the store keyed "have the usage aggregates been applied" on `usageAggAppliedAt`
 * rather than on the status. A row that had already been refunded (by the failure path or by the
 * stale-reservation sweeper) had never applied its aggregates, so a late settle both flipped it to
 * charged and billed usage for credits that were sitting back in the workspace balance.
 *
 * The store below is a faithful in-memory copy of what Mongo now does: the status filter is part of
 * the write, and the usage aggregates are applied only when the write actually moved the row.
 */
type Row = {
  id: string;
  workspaceId: string;
  userId: string;
  docId: string | null;
  actionType: any;
  qualityTier: any;
  status: LedgerStatus;
  creditsReserved: number;
  creditsEstimated: number;
  creditsCharged: number;
  creditsFrom: Record<string, number>;
  usageAggAppliedAt: Date | null;
};

function makeStore(init: { balance: WorkspaceBalanceSnapshot }) {
  let balance: WorkspaceBalanceSnapshot = { ...init.balance };
  const byKey = new Map<string, string>();
  const rows = new Map<string, Row>();
  const usage = { applications: 0, credits: 0 };
  let nextId = 1;

  function seedRow(over: Partial<Row>): Row {
    const id = String(nextId++);
    const row: Row = {
      id,
      workspaceId: "w1",
      userId: "u1",
      docId: null,
      actionType: "summary",
      qualityTier: "basic",
      status: "pending",
      creditsReserved: 0,
      creditsEstimated: 0,
      creditsCharged: 0,
      creditsFrom: { trial: 0, subscription: 0, purchased: 0, on_demand: 0 },
      usageAggAppliedAt: null,
      ...over,
    };
    rows.set(id, row);
    return row;
  }

  const store: CreditStore = {
    async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
      return await fn();
    },

    async getLedgerByIdempotencyKey({ idempotencyKey }) {
      const id = byKey.get(idempotencyKey);
      const row = id ? rows.get(id) : undefined;
      return row
        ? { id: row.id, status: row.status, creditsReserved: row.creditsReserved, creditsEstimated: row.creditsEstimated }
        : null;
    },

    async createPendingLedger(args) {
      const row = seedRow({
        workspaceId: args.workspaceId,
        userId: args.userId,
        docId: args.docId,
        actionType: args.actionType,
        qualityTier: args.qualityTier,
        creditsReserved: args.creditsReserved,
        creditsEstimated: args.creditsEstimated,
        creditsFrom: args.creditsFrom as Record<string, number>,
      });
      byKey.set(args.idempotencyKey, row.id);
      return { id: row.id };
    },

    async getOrCreateBalance() {
      return { ...balance };
    },

    async saveBalance({ next }) {
      balance = { ...next };
    },

    async getUsageSums() {
      return { dailyReserved: 0, monthlyReserved: 0, monthlyOnDemandReserved: 0 };
    },

    async getLedgerById({ ledgerId }) {
      const row = rows.get(ledgerId);
      return row
        ? {
            id: row.id,
            status: row.status,
            creditsReserved: row.creditsReserved,
            creditsEstimated: row.creditsEstimated,
            workspaceId: row.workspaceId,
            userId: row.userId,
            docId: row.docId,
            actionType: row.actionType,
            qualityTier: row.qualityTier,
            creditsFrom: row.creditsFrom as any,
          }
        : null;
    },

    async setLedgerStatus({ ledgerId, status, expectedStatus, creditsCharged }): Promise<LedgerTransition> {
      const row = rows.get(ledgerId);
      if (!row) return { moved: false, previousStatus: null };
      // The guard is part of the write, exactly as the Mongo filter is.
      if (expectedStatus && expectedStatus.length > 0 && !expectedStatus.includes(row.status)) {
        return { moved: false, previousStatus: row.status };
      }
      const previousStatus = row.status;
      row.status = status;
      if (typeof creditsCharged === "number") row.creditsCharged = creditsCharged;
      if (status === "charged" && row.usageAggAppliedAt === null) {
        row.usageAggAppliedAt = new Date();
        usage.applications += 1;
        usage.credits += row.creditsCharged;
      }
      return { moved: true, previousStatus };
    },
  };

  return {
    store,
    seedRow,
    usage,
    getBalance: () => ({ ...balance }),
    getRow: (id: string) => rows.get(id)!,
  };
}

function baseBalance(): WorkspaceBalanceSnapshot {
  return {
    trialCreditsRemaining: 0,
    subscriptionCreditsRemaining: 100,
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

/** Reserves one standard review (a fixed 5 credits on the schedule). */
async function reserve(svc: ReturnType<typeof createCreditService>, idempotencyKey = "k1") {
  return await svc.reserveCreditsOrThrow({
    workspaceId: "w1",
    userId: "u1",
    docId: null,
    actionType: "review",
    qualityTier: "standard",
    idempotencyKey,
    initBalanceIfMissing: async () => baseBalance(),
  });
}

describe("credits/serviceCore ledger state guards", () => {
  test("reserve then settle charges once and debits the balance once", async () => {
    const h = makeStore({ balance: baseBalance() });
    const svc = createCreditService(h.store);

    const reserved = await reserve(svc);
    expect(reserved.status).toBe("pending");
    const afterReserve = h.getBalance().subscriptionCreditsRemaining;
    expect(afterReserve).toBe(100 - reserved.creditsReserved);

    const settled = await svc.markLedgerCharged({ ledgerId: reserved.ledgerId, creditsCharged: reserved.creditsReserved });
    expect(h.getRow(reserved.ledgerId).status).toBe("charged");

    // The credits left the balance at reserve time: settling must not take them a second time.
    expect(h.getBalance().subscriptionCreditsRemaining).toBe(afterReserve);
    expect(h.usage.applications).toBe(1);
    expect(h.usage.credits).toBe(reserved.creditsReserved);
    expect(settled).toEqual({ moved: true, previousStatus: "pending" });
  });

  test("a settle on an already refunded row does not move it and applies no usage", async () => {
    const h = makeStore({ balance: baseBalance() });
    const svc = createCreditService(h.store);

    const reserved = await reserve(svc);
    const refund = await svc.failAndRefundLedger({ ledgerId: reserved.ledgerId });
    expect(h.getBalance().subscriptionCreditsRemaining).toBe(100);
    expect(h.getRow(reserved.ledgerId).status).toBe("failed");

    // The late settle: the run finished after the sweeper had already handed the credits back.
    const settled = await svc.markLedgerCharged({ ledgerId: reserved.ledgerId, creditsCharged: reserved.creditsReserved });

    // The defect: usage used to be billed here for credits that were back in the balance.
    expect(h.usage.applications).toBe(0);
    expect(h.usage.credits).toBe(0);
    expect(h.getRow(reserved.ledgerId).status).toBe("failed");
    expect(h.getRow(reserved.ledgerId).creditsCharged).toBe(0);
    expect(h.getBalance().subscriptionCreditsRemaining).toBe(100);

    expect(settled).toEqual({ moved: false, previousStatus: "failed" });
    expect(refund).toEqual({ moved: true, previousStatus: "pending", creditsRefunded: reserved.creditsReserved });
  });

  test("a settle on an already charged row is a no-op and reports it", async () => {
    const h = makeStore({ balance: baseBalance() });
    const svc = createCreditService(h.store);

    const reserved = await reserve(svc);
    const first = await svc.markLedgerCharged({ ledgerId: reserved.ledgerId, creditsCharged: 5 });
    const second = await svc.markLedgerCharged({ ledgerId: reserved.ledgerId, creditsCharged: 999 });

    // The replay must not re-stamp the row, and must not bill its usage again.
    expect(h.getRow(reserved.ledgerId).creditsCharged).toBe(5);
    expect(h.usage.applications).toBe(1);

    expect(first).toEqual({ moved: true, previousStatus: "pending" });
    expect(second).toEqual({ moved: false, previousStatus: "charged" });
  });

  test("a refund after a settle does not return the credits twice", async () => {
    const h = makeStore({ balance: baseBalance() });
    const svc = createCreditService(h.store);

    const reserved = await reserve(svc);
    const afterReserve = h.getBalance().subscriptionCreditsRemaining;
    await svc.markLedgerCharged({ ledgerId: reserved.ledgerId, creditsCharged: reserved.creditsReserved });

    const refund = await svc.failAndRefundLedger({ ledgerId: reserved.ledgerId });
    expect(refund).toEqual({ moved: false, previousStatus: "charged", creditsRefunded: 0 });
    expect(h.getBalance().subscriptionCreditsRemaining).toBe(afterReserve);
    expect(h.getRow(reserved.ledgerId).status).toBe("charged");
  });

  test("a second refund of the same row returns nothing", async () => {
    const h = makeStore({ balance: baseBalance() });
    const svc = createCreditService(h.store);

    const reserved = await reserve(svc);
    await svc.failAndRefundLedger({ ledgerId: reserved.ledgerId });
    expect(h.getBalance().subscriptionCreditsRemaining).toBe(100);

    const again = await svc.failAndRefundLedger({ ledgerId: reserved.ledgerId });
    expect(again).toEqual({ moved: false, previousStatus: "failed", creditsRefunded: 0 });
    expect(h.getBalance().subscriptionCreditsRemaining).toBe(100);
  });

  test("refunding a row that does not exist reports no move", async () => {
    const h = makeStore({ balance: baseBalance() });
    const svc = createCreditService(h.store);
    expect(await svc.failAndRefundLedger({ ledgerId: "nope" })).toEqual({
      moved: false,
      previousStatus: null,
      creditsRefunded: 0,
    });
  });

  /**
   * Deliberate behaviour, pinned: the runs that cost nothing (an agent-written summary, a recipient
   * upload, an unchanged replacement) still settle exactly once through the guarded edge, and
   * neither the settle nor a later refund attempt moves a single credit.
   */
  test("a zero-credit run settles once, bills nothing, and cannot be refunded into credits", async () => {
    const h = makeStore({ balance: baseBalance() });
    const svc = createCreditService(h.store);
    const row = h.seedRow({ creditsReserved: 0, creditsEstimated: 0 });

    const settled = await svc.markLedgerCharged({ ledgerId: row.id, creditsCharged: 0 });
    expect(settled).toEqual({ moved: true, previousStatus: "pending" });
    expect(h.usage.applications).toBe(1);
    expect(h.usage.credits).toBe(0);
    expect(h.getBalance().subscriptionCreditsRemaining).toBe(100);

    const refund = await svc.failAndRefundLedger({ ledgerId: row.id });
    expect(refund).toEqual({ moved: false, previousStatus: "charged", creditsRefunded: 0 });
    expect(h.getBalance().subscriptionCreditsRemaining).toBe(100);
  });

  /**
   * A store written before the guard existed reports nothing back. The service must keep treating
   * that as "the write landed" so those stores behave exactly as they did.
   */
  test("a store that reports no transition is still treated as having moved the row", async () => {
    const h = makeStore({ balance: baseBalance() });
    const legacy: CreditStore = {
      ...h.store,
      async setLedgerStatus(args) {
        await h.store.setLedgerStatus(args);
      },
    };
    const svc = createCreditService(legacy);
    const reserved = await reserve(svc);
    expect(await svc.markLedgerCharged({ ledgerId: reserved.ledgerId, creditsCharged: 5 })).toEqual({
      moved: true,
      previousStatus: null,
    });
  });
});
