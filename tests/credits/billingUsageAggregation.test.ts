import { describe, expect, test } from "vitest";

import { aggregateBillingUsage, type BillingLedgerRow } from "@/lib/billing/usageAggregation";

function l(overrides: Partial<BillingLedgerRow>): BillingLedgerRow {
  return {
    actionType: "summary",
    qualityTier: "standard",
    modelRoute: null,
    status: "charged",
    creditsCharged: 0,
    creditsFromTrial: 0,
    creditsFromSubscription: 0,
    creditsFromPurchased: 0,
    creditsFromOnDemand: 0,
    costUsdActual: null,
    ...overrides,
  };
}

describe("billing/usageAggregation", () => {
  test("only included usage", () => {
    const out = aggregateBillingUsage({
      ledgers: [
        l({ creditsFromSubscription: 10, creditsCharged: 10 }),
        l({ actionType: "review", qualityTier: "advanced", creditsFromTrial: 5, creditsCharged: 5 }),
      ],
      onDemandLimitCents: 10_000,
    });

    expect(out.included.rows.length).toBe(2);
    expect(out.included.total.credits).toBe(15);

    expect(out.onDemand.rows).toEqual([]);
    expect(out.onDemand.usedCents).toBe(0);
    expect(out.onDemand.adjustments).toEqual([]);
  });

  test("included + on-demand without Stripe cost does not fabricate dollars", () => {
    const out = aggregateBillingUsage({
      ledgers: [
        l({ creditsFromSubscription: 5, creditsCharged: 5 }),
        l({ modelRoute: "non-max-gpt-5.2", creditsFromOnDemand: 3, creditsCharged: 3 }),
      ],
      onDemandLimitCents: 5_000,
    });

    expect(out.included.total.credits).toBe(5);
    expect(out.onDemand.rows.length).toBe(1);
    expect(out.onDemand.rows[0]?.credits).toBe(3);
    expect(out.onDemand.rows[0]?.totalCents).toBe(null);
    expect(out.onDemand.usedCents).toBe(0);
    expect(out.onDemand.subtotalCents).toBe(0);
  });

  test("refunds present (on-demand adjustments)", () => {
    const out = aggregateBillingUsage({
      ledgers: [
        l({ modelRoute: "non-max-gpt-5.2", creditsFromOnDemand: 25, creditsCharged: 25, costUsdActual: 2.5 }),
        l({ status: "refunded", modelRoute: "non-max-gpt-5.2", creditsFromOnDemand: 10, creditsCharged: 10, costUsdActual: 1.0 }),
      ],
      onDemandLimitCents: 50_000,
    });

    expect(out.onDemand.subtotalCents).toBe(250);
    expect(out.onDemand.adjustments).toEqual([{ description: "Refunds", totalCents: -100 }]);
    expect(out.onDemand.usedCents).toBe(150);
  });
});


