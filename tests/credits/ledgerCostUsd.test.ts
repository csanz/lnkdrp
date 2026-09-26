/**
 * `costUsdActual` on a ledger row, and why it is filled at settle time rather than at the call
 * sites.
 *
 * The field existed on the schema for a long time and nothing ever wrote it, so every margin
 * statement about the product was an assumption. It could not be fixed at the four AI call sites:
 * they disagree about which telemetry they can produce (a compare knows its images, a summary knows
 * its retries, a review told the ledger nothing at all), two of them live in route files, and every
 * site that has to remember a cost line is a site that can forget one. Settling is the one moment
 * every charge passes through.
 *
 * These pin what that derivation must and must not do. The must-not half matters more: a zero
 * written where a cost is unknown is invisible, and it makes every report that sums the column read
 * as if the missing runs were free.
 */
import { describe, expect, test } from "vitest";

import { createCreditService } from "@/lib/credits/serviceCore";
import type { CreditStore, LedgerTransition, WorkspaceBalanceSnapshot } from "@/lib/credits/store";
import type { LedgerStatus } from "@/lib/credits/types";

const BALANCE: WorkspaceBalanceSnapshot = {
  trialCreditsRemaining: 100,
  subscriptionCreditsRemaining: 0,
  purchasedCreditsRemaining: 0,
  onDemandEnabled: false,
  onDemandMonthlyLimitCents: 0,
  dailyCreditCap: null,
  monthlyCreditCap: null,
  perRunCreditCapBasic: 20,
  perRunCreditCapStandard: 60,
  perRunCreditCapAdvanced: 150,
  currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
  currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
};

/**
 * A store that records only what `setLedgerStatus` was handed.
 *
 * The question these tests ask is what the service decided to write, not what Mongo then did with
 * it, so the store keeps the last telemetry record and nothing else.
 */
function makeStore() {
  const seen: Array<Record<string, unknown> | null> = [];
  let status: LedgerStatus = "pending";

  const store: CreditStore = {
    async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
      return await fn();
    },
    async getLedgerByIdempotencyKey() {
      return null;
    },
    async createPendingLedger() {
      return { id: "ledger-1" };
    },
    async getOrCreateBalance() {
      return { ...BALANCE };
    },
    async saveBalance() {
      // Not exercised here: settling moves no credits.
    },
    async getUsageSums() {
      return { dailyReserved: 0, monthlyReserved: 0, monthlyOnDemandReserved: 0 };
    },
    async getLedgerById() {
      return null;
    },
    async setLedgerStatus({ telemetry }): Promise<LedgerTransition> {
      seen.push(telemetry ?? null);
      const previousStatus = status;
      status = "charged";
      return { moved: true, previousStatus };
    },
  };

  return { store, seen };
}

/** Settle one row with the given telemetry and return what the store was handed. */
async function settleWith(telemetry: Record<string, unknown> | null): Promise<Record<string, unknown> | null> {
  const { store, seen } = makeStore();
  const svc = createCreditService(store);
  await svc.markLedgerCharged({ ledgerId: "ledger-1", creditsCharged: 1, telemetry });
  return seen[0] ?? null;
}

describe("settling a charge prices it", () => {
  test("fills costUsdActual from the tokens and model the run reported", async () => {
    const written = await settleWith({
      provider: "openai",
      modelRoute: "gpt-4o-mini",
      promptTokens: 40_000,
      completionTokens: 1_000,
      totalTokens: 41_000,
    });
    // 40,000 x 0.15 + 1,000 x 0.60, per million.
    expect(written?.costUsdActual).toBeCloseTo(0.0066, 6);
  });

  test("prices a page-image run at the model it actually ran on, not the one its tier implies", async () => {
    // A basic compare carrying page images goes to gpt-4o. Priced at mini this would read 0.0013.
    const written = await settleWith({
      provider: "openai",
      modelRoute: "gpt-4o",
      promptTokens: 8_500,
      completionTokens: 400,
    });
    expect(written?.costUsdActual).toBeCloseTo(0.025250, 6);
  });

  test("keeps every field the run reported, so the tokens survive beside the cost", async () => {
    const written = await settleWith({
      provider: "openai",
      modelRoute: "gpt-4o",
      promptTokens: 1_000,
      completionTokens: 100,
      imagesAttached: 6,
      pagesAttached: 3,
    });
    expect(written?.imagesAttached).toBe(6);
    expect(written?.pagesAttached).toBe(3);
    expect(written?.promptTokens).toBe(1_000);
  });
});

describe("what settling refuses to invent", () => {
  test("writes no cost at all for a model the price table does not know", async () => {
    const written = await settleWith({
      provider: "openai",
      modelRoute: "some-new-model",
      promptTokens: 10_000,
      completionTokens: 500,
    });
    // Absent, not zero: the row keeps its null and the margin report counts it as unpriced.
    expect(written).not.toBeNull();
    expect("costUsdActual" in (written as Record<string, unknown>)).toBe(false);
  });

  test("writes no cost when the run reported no usage", async () => {
    const written = await settleWith({ provider: "openai", modelRoute: "gpt-4o" });
    expect("costUsdActual" in (written as Record<string, unknown>)).toBe(false);
  });

  test("leaves a cost the caller computed itself alone", async () => {
    // A charge that spanned two models knows more than one row of token fields can express.
    const written = await settleWith({
      provider: "openai",
      modelRoute: "gpt-4o-mini+gpt-4o",
      promptTokens: 2_000_000,
      completionTokens: 0,
      costUsdActual: 2.65,
    });
    expect(written?.costUsdActual).toBe(2.65);
  });

  test("a charge with no telemetry at all stays untouched", async () => {
    expect(await settleWith(null)).toBeNull();
  });
});
