import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The Free starter grant must land exactly once per Free workspace, personal or team (since
 * 2026-09-17; it was personal-only before), and never on a Pro workspace, no matter which path
 * creates the balance row first: the dashboard snapshot
 * (`getCreditsSnapshot`) or the reserve path (`reserveCreditsOrThrow` via
 * `defaultBalanceForWorkspace`). Both seed through `starterCreditsForWorkspace`.
 *
 * The Mongo store used by `reserveCreditsOrThrow` needs a real session, so the reserve path is
 * exercised through `createCreditService` with an in-memory store and the real initializer.
 */
// Hoisted so the `vi.mock` factories below (which vitest lifts to the top of the file) can see them.
const { state, findOneChain, balanceUpdateOne } = vi.hoisted(() => {
  const state = {
    orgType: "personal" as "personal" | "team",
    subscriptionStatus: null as string | null,
    /** The balance row the snapshot finds (null = no row yet). */
    balanceDoc: null as Record<string, unknown> | null,
  };
  /** `Model.findOne(...).select(...).lean()` chain resolving to `value()`. */
  function findOneChain(value: () => unknown) {
    return vi.fn(() => ({
      select: vi.fn(() => ({
        lean: vi.fn(async () => value()),
      })),
    }));
  }
  const balanceUpdateOne = vi.fn(async () => ({ acknowledged: true }));
  return { state, findOneChain, balanceUpdateOne };
});

vi.mock("@/lib/mongodb", () => ({
  connectMongo: vi.fn(async () => {}),
}));

vi.mock("@/lib/models/Org", () => ({
  OrgModel: { findOne: findOneChain(() => ({ type: state.orgType })) },
}));

vi.mock("@/lib/models/Subscription", () => ({
  SubscriptionModel: {
    findOne: findOneChain(() => (state.subscriptionStatus ? { status: state.subscriptionStatus } : null)),
  },
}));

vi.mock("@/lib/models/WorkspaceCreditBalance", () => ({
  WorkspaceCreditBalanceModel: {
    findOne: findOneChain(() => state.balanceDoc),
    updateOne: balanceUpdateOne,
  },
}));

vi.mock("@/lib/models/UsageAggCycle", () => ({
  UsageAggCycleModel: { findOne: findOneChain(() => null) },
}));

vi.mock("@/lib/models/CreditLedger", () => ({
  CreditLedgerModel: { aggregate: vi.fn(async () => []) },
}));

import { FREE_STARTER_CREDITS } from "@/lib/credits/grants";
import { FREE_DAILY_CREDIT_CAP, defaultBalanceForWorkspace, starterCreditsForWorkspace } from "@/lib/credits/creditService";
import { getCreditsSnapshot } from "@/lib/credits/snapshot";
import { createCreditService } from "@/lib/credits/serviceCore";
import type { CreditStore, WorkspaceBalanceSnapshot } from "@/lib/credits/store";

const ORG_ID = "507f1f77bcf86cd799439011";
const USER_ID = "507f1f77bcf86cd799439012";

/** Minimal in-memory store: enough for one reserve; `balance` may start empty. */
function makeStore(initial: WorkspaceBalanceSnapshot | null, usage?: { daily?: number }) {
  let balance: WorkspaceBalanceSnapshot | null = initial ? { ...initial } : null;
  let nextId = 1;
  const store: CreditStore = {
    async withTransaction(fn) {
      return await fn();
    },
    async getLedgerByIdempotencyKey() {
      return null;
    },
    async createPendingLedger() {
      return { id: String(nextId++) };
    },
    async getOrCreateBalance({ initIfMissing }) {
      if (!balance) balance = await initIfMissing();
      return { ...balance };
    },
    async saveBalance({ next }) {
      balance = { ...next };
    },
    async getUsageSums() {
      return { dailyReserved: usage?.daily ?? 0, monthlyReserved: 0, monthlyOnDemandReserved: 0 };
    },
    async getLedgerById() {
      return null;
    },
    async setLedgerStatus() {},
  };
  return { store, getBalance: () => (balance ? { ...balance } : null) };
}

/** One Basic summary run (1 credit) through the real default initializer. */
async function reserveSummary(store: CreditStore, init: () => Promise<WorkspaceBalanceSnapshot>) {
  return createCreditService(store).reserveCreditsOrThrow({
    workspaceId: ORG_ID,
    userId: USER_ID,
    actionType: "summary",
    qualityTier: "basic",
    idempotencyKey: `k-${Math.random()}`,
    initBalanceIfMissing: init,
    isOnDemandEligible: async () => false,
  });
}

/** What the snapshot wrote with `$setOnInsert` on its last upsert. */
function lastSeedWritten(): Record<string, unknown> {
  const call = balanceUpdateOne.mock.calls.at(-1) as unknown as [unknown, { $setOnInsert: Record<string, unknown> }] | undefined;
  if (!call) throw new Error("snapshot did not upsert a balance row");
  return call[1].$setOnInsert;
}

beforeEach(() => {
  state.orgType = "personal";
  state.subscriptionStatus = null;
  state.balanceDoc = null;
  balanceUpdateOne.mockClear();
});

describe("credits starterCreditsForWorkspace", () => {
  test("personal Free → FREE_STARTER_CREDITS", async () => {
    expect(await starterCreditsForWorkspace(ORG_ID)).toBe(FREE_STARTER_CREDITS);
  });

  test("team Free → FREE_STARTER_CREDITS too (each workspace is its own customer)", async () => {
    state.orgType = "team";
    expect(await starterCreditsForWorkspace(ORG_ID)).toBe(FREE_STARTER_CREDITS);
  });

  test("team Pro → 0", async () => {
    state.orgType = "team";
    state.subscriptionStatus = "active";
    expect(await starterCreditsForWorkspace(ORG_ID)).toBe(0);
  });

  test.each(["active", "trialing"])("personal Pro (%s) → 0", async (status) => {
    state.subscriptionStatus = status;
    expect(await starterCreditsForWorkspace(ORG_ID)).toBe(0);
  });

  test("rejects a malformed workspace id", async () => {
    await expect(starterCreditsForWorkspace("nope")).rejects.toThrow(/Invalid workspaceId/);
  });
});

describe("credits defaultBalanceForWorkspace (reserve-path seed)", () => {
  test("personal Free: 50 starter credits and the daily brake", async () => {
    const seed = await defaultBalanceForWorkspace(ORG_ID);
    expect(seed.trialCreditsRemaining).toBe(FREE_STARTER_CREDITS);
    expect(seed.dailyCreditCap).toBe(FREE_DAILY_CREDIT_CAP);
    expect(seed.subscriptionCreditsRemaining).toBe(0);
    expect(seed.purchasedCreditsRemaining).toBe(0);
    expect(seed.monthlyCreditCap).toBeNull();
  });

  test("team Free: 50 starter credits and the daily brake", async () => {
    state.orgType = "team";
    const seed = await defaultBalanceForWorkspace(ORG_ID);
    expect(seed.trialCreditsRemaining).toBe(FREE_STARTER_CREDITS);
    expect(seed.dailyCreditCap).toBe(FREE_DAILY_CREDIT_CAP);
  });

  test("Pro: 0 starter credits and no daily cap", async () => {
    state.subscriptionStatus = "active";
    const seed = await defaultBalanceForWorkspace(ORG_ID);
    expect(seed.trialCreditsRemaining).toBe(0);
    expect(seed.dailyCreditCap).toBeNull();
  });
});

describe("credits getCreditsSnapshot seeds through the shared helper", () => {
  test("personal Free: upserts 50 + daily cap and reports them as included", async () => {
    const snap = await getCreditsSnapshot({ workspaceId: ORG_ID });
    expect(balanceUpdateOne).toHaveBeenCalledTimes(1);
    const seed = lastSeedWritten();
    expect(seed.trialCreditsRemaining).toBe(FREE_STARTER_CREDITS);
    expect(seed.dailyCreditCap).toBe(FREE_DAILY_CREDIT_CAP);
    expect(snap.includedRemaining).toBe(FREE_STARTER_CREDITS);
    expect(snap.includedThisCycle).toBe(FREE_STARTER_CREDITS);
    expect(snap.blocked).toBe(false);
  });

  test("team Free: upserts 50 and is not blocked (a new team workspace opened on a blocked banner)", async () => {
    state.orgType = "team";
    const snap = await getCreditsSnapshot({ workspaceId: ORG_ID });
    expect(lastSeedWritten().trialCreditsRemaining).toBe(FREE_STARTER_CREDITS);
    expect(snap.includedRemaining).toBe(FREE_STARTER_CREDITS);
    expect(snap.blocked).toBe(false);
  });

  test("Pro: upserts 0 with no daily cap", async () => {
    state.subscriptionStatus = "active";
    await getCreditsSnapshot({ workspaceId: ORG_ID });
    const seed = lastSeedWritten();
    expect(seed.trialCreditsRemaining).toBe(0);
    expect(seed.dailyCreditCap).toBeNull();
  });

  test("does not touch an existing row", async () => {
    state.balanceDoc = { trialCreditsRemaining: 7, subscriptionCreditsRemaining: 0, purchasedCreditsRemaining: 0 };
    const snap = await getCreditsSnapshot({ workspaceId: ORG_ID });
    expect(balanceUpdateOne).not.toHaveBeenCalled();
    expect(snap.includedRemaining).toBe(7);
  });
});

describe("credits starter grant lands exactly once across snapshot and reserve", () => {
  test("snapshot first, then reserve: the reserve path finds the row and does not re-seed", async () => {
    await getCreditsSnapshot({ workspaceId: ORG_ID });
    const rowFromSnapshot = lastSeedWritten() as unknown as WorkspaceBalanceSnapshot;

    const { store, getBalance } = makeStore(rowFromSnapshot);
    const init = vi.fn(() => defaultBalanceForWorkspace(ORG_ID));
    await reserveSummary(store, init);

    expect(init).not.toHaveBeenCalled();
    expect(getBalance()?.trialCreditsRemaining).toBe(FREE_STARTER_CREDITS - 1);
  });

  test("reserve first, then snapshot: the snapshot finds the row and does not re-seed", async () => {
    const { store, getBalance } = makeStore(null);
    const init = vi.fn(() => defaultBalanceForWorkspace(ORG_ID));
    await reserveSummary(store, init);
    expect(init).toHaveBeenCalledTimes(1);
    const row = getBalance();
    expect(row?.trialCreditsRemaining).toBe(FREE_STARTER_CREDITS - 1);
    expect(row?.dailyCreditCap).toBe(FREE_DAILY_CREDIT_CAP);

    state.balanceDoc = row as unknown as Record<string, unknown>;
    const snap = await getCreditsSnapshot({ workspaceId: ORG_ID });
    expect(balanceUpdateOne).not.toHaveBeenCalled();
    expect(snap.includedRemaining).toBe(FREE_STARTER_CREDITS - 1);
  });

  test("team workspace seeds 50 on the reserve path and the run is charged from it", async () => {
    state.orgType = "team";
    const { store, getBalance } = makeStore(null);
    await reserveSummary(store, () => defaultBalanceForWorkspace(ORG_ID));
    expect(getBalance()?.trialCreditsRemaining).toBe(FREE_STARTER_CREDITS - 1);
  });

  test("Free daily brake: the 16th credit of the day is refused with the daily-cap error", async () => {
    const { store } = makeStore(null, { daily: FREE_DAILY_CREDIT_CAP });
    await expect(reserveSummary(store, () => defaultBalanceForWorkspace(ORG_ID))).rejects.toThrow(/Daily credit cap exceeded/);
  });
});
