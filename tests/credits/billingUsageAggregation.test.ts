import { describe, expect, test } from "vitest";

import { aggregateBillingUsage, type BillingLedgerRow } from "@/lib/billing/usageAggregation";
import { USD_CENTS_PER_CREDIT } from "@/lib/billing/pricing";

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

  /**
   * Regression: on-demand rows are priced from credits, never from a stored cost.
   *
   * When this was written nothing wrote `costUsdActual`, so every on-demand row arrived with a
   * null cost, the bucket read as "unknown" and the billing table printed "Not available" for
   * usage the customer was invoiced for. `markLedgerCharged` fills the field now, which changes
   * nothing here and must not: on-demand is billed at the flat USD_CENTS_PER_CREDIT a credit, so
   * credits price the row exactly and the stored figure is our provider cost, not the price.
   */
  test("included + on-demand without a stored cost is priced at the flat per-credit rate", () => {
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
    expect(out.onDemand.rows[0]?.costCents).toBe(USD_CENTS_PER_CREDIT);
    expect(out.onDemand.rows[0]?.totalCents).toBe(3 * USD_CENTS_PER_CREDIT);
    expect(out.onDemand.usedCents).toBe(3 * USD_CENTS_PER_CREDIT);
    expect(out.onDemand.subtotalCents).toBe(3 * USD_CENTS_PER_CREDIT);
  });

  test("refunds without a stored cost are netted at the same flat rate", () => {
    const out = aggregateBillingUsage({
      ledgers: [
        l({ modelRoute: "non-max-gpt-5.2", creditsFromOnDemand: 25, creditsCharged: 25 }),
        l({ status: "refunded", modelRoute: "non-max-gpt-5.2", creditsFromOnDemand: 10, creditsCharged: 10 }),
      ],
      onDemandLimitCents: 50_000,
    });

    expect(out.onDemand.subtotalCents).toBe(250);
    expect(out.onDemand.adjustments).toEqual([{ description: "Refunds", totalCents: -100 }]);
    expect(out.onDemand.usedCents).toBe(150);
  });

  test("rows with no on-demand credits stay out of the table", () => {
    const out = aggregateBillingUsage({
      ledgers: [l({ creditsFromSubscription: 4, creditsCharged: 4 })],
      onDemandLimitCents: 5_000,
    });

    expect(out.onDemand.rows).toEqual([]);
    expect(out.onDemand.usedCents).toBe(0);
  });

  /**
   * The case that made `costUsdActual` dangerous to read here.
   *
   * Since 2026-09-26 a settled run records what it cost us, and the overwhelming majority of runs
   * are funded by a Pro allowance: `creditsFromSubscription`, `creditsFromOnDemand: 0`, and now a
   * non-null cost. While a stored cost could put a row on the on-demand table and price it, that
   * run appeared as billable overage and was invoiced at our provider cost, on top of the
   * subscription the customer had already paid. It contributes to Included usage and to nothing
   * else, whatever it cost us.
   */
  test("an allowance-funded row carrying our provider cost never reaches the on-demand table", () => {
    const out = aggregateBillingUsage({
      ledgers: [
        l({ modelRoute: "gpt-4o", creditsFromSubscription: 5, creditsCharged: 5, costUsdActual: 0.0147 }),
        l({ modelRoute: "gpt-4o", creditsFromTrial: 2, creditsCharged: 2, costUsdActual: 0.0093 }),
        l({ modelRoute: "gpt-4o", creditsFromPurchased: 3, creditsCharged: 3, costUsdActual: 0.0078 }),
      ],
      onDemandLimitCents: 5_000,
    });

    expect(out.included.total.credits).toBe(10);
    expect(out.onDemand.rows).toEqual([]);
    expect(out.onDemand.usedCents).toBe(0);
    expect(out.onDemand.subtotalCents).toBe(0);
  });

  /**
   * A genuine on-demand row is still priced at the flat rate once it carries a cost, not at the
   * cost. 3 credits are 3 x USD_CENTS_PER_CREDIT whether the run cost us a cent or a dollar.
   */
  test("a stored cost never prices an on-demand line", () => {
    const cheap = aggregateBillingUsage({
      ledgers: [l({ modelRoute: "gpt-4o", creditsFromOnDemand: 3, creditsCharged: 3, costUsdActual: 0.0147 })],
      onDemandLimitCents: 5_000,
    });
    const dear = aggregateBillingUsage({
      ledgers: [l({ modelRoute: "gpt-4o", creditsFromOnDemand: 3, creditsCharged: 3, costUsdActual: 9.99 })],
      onDemandLimitCents: 5_000,
    });

    expect(cheap.onDemand.subtotalCents).toBe(3 * USD_CENTS_PER_CREDIT);
    expect(dear.onDemand.subtotalCents).toBe(3 * USD_CENTS_PER_CREDIT);
    expect(dear.onDemand.rows[0]?.costCents).toBe(USD_CENTS_PER_CREDIT);
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


