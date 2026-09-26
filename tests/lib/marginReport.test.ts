/**
 * The arithmetic behind the admin margin table.
 *
 * The trap it exists to avoid: a window where some runs carry a cost and some do not. Dividing the
 * summed cost by every credit charged in the window answers a question nobody asked, and it answers
 * it low, because the unpriced runs contribute credits and no dollars. The cheaper a feature looks,
 * the less anyone checks it, so these pin that every ratio is taken over the priced runs alone and
 * that the unpriced ones stay visible as a count.
 */
import { describe, expect, test } from "vitest";

import { LIST_RATE_USD_PER_CREDIT, marginRow, marginTotal, type MarginBucketSums } from "@/lib/credits/marginReport";

function sums(over: Partial<MarginBucketSums> = {}): MarginBucketSums {
  return {
    key: "summary",
    runs: 0,
    creditsCharged: 0,
    pricedRuns: 0,
    pricedCredits: 0,
    costUsd: 0,
    estimatedRuns: 0,
    promptTokens: 0,
    completionTokens: 0,
    ...over,
  };
}

describe("a fully priced bucket", () => {
  test("reports cost per credit, list-rate revenue and the margin between them", () => {
    const row = marginRow(sums({ runs: 10, creditsCharged: 10, pricedRuns: 10, pricedCredits: 10, costUsd: 0.4 }));
    expect(row.costPerCreditUsd).toBeCloseTo(0.04, 6);
    expect(row.listRateUsd).toBeCloseTo(1.0, 6);
    expect(row.marginUsd).toBeCloseTo(0.6, 6);
    expect(row.marginRatio).toBeCloseTo(0.6, 6);
    expect(row.costPerRunUsd).toBeCloseTo(0.04, 6);
    expect(row.unpricedRuns).toBe(0);
  });

  test("an action that costs more than it charges reports a negative margin rather than hiding it", () => {
    const row = marginRow(sums({ key: "brief", runs: 5, creditsCharged: 5, pricedRuns: 5, pricedCredits: 5, costUsd: 0.9 }));
    expect(row.marginUsd).toBeCloseTo(-0.4, 6);
    expect(row.marginRatio).toBeLessThan(0);
  });
});

describe("a bucket where only some runs are priced", () => {
  test("divides cost by the credits of the priced runs, not by every credit in the window", () => {
    // 100 runs charged 100 credits; only 10 of them carry a cost, and those 10 charged 10 credits.
    const row = marginRow(sums({ runs: 100, creditsCharged: 100, pricedRuns: 10, pricedCredits: 10, costUsd: 0.4 }));
    expect(row.unpricedRuns).toBe(90);
    // 0.04, the cost per credit of the runs we can price. Over all 100 credits it would read 0.004,
    // a tenfold understatement that looks like an excellent margin.
    expect(row.costPerCreditUsd).toBeCloseTo(0.04, 6);
    expect(row.listRateUsd).toBeCloseTo(1.0, 6);
  });

  test("a bucket with nothing priced has no margin at all, rather than a perfect one", () => {
    const row = marginRow(sums({ runs: 40, creditsCharged: 40, pricedRuns: 0, pricedCredits: 0, costUsd: 0 }));
    expect(row.unpricedRuns).toBe(40);
    expect(row.costPerCreditUsd).toBeNull();
    expect(row.marginUsd).toBeNull();
    expect(row.marginRatio).toBeNull();
    expect(row.costPerRunUsd).toBeNull();
  });
});

describe("the total line", () => {
  test("adds the buckets rather than re-deriving ratios from them", () => {
    const total = marginTotal([
      sums({ key: "summary", runs: 10, creditsCharged: 10, pricedRuns: 10, pricedCredits: 10, costUsd: 0.1 }),
      sums({ key: "history", runs: 2, creditsCharged: 10, pricedRuns: 1, pricedCredits: 5, costUsd: 0.5 }),
    ]);
    expect(total.key).toBe("all");
    expect(total.runs).toBe(12);
    expect(total.creditsCharged).toBe(20);
    expect(total.pricedCredits).toBe(15);
    expect(total.costUsd).toBeCloseTo(0.6, 6);
    // Averaging the two buckets' cost-per-credit would give 0.10; the honest figure is 0.04.
    expect(total.costPerCreditUsd).toBeCloseTo(0.04, 6);
    expect(total.unpricedRuns).toBe(1);
  });

  test("an empty window is all nulls and no division by zero", () => {
    const total = marginTotal([]);
    expect(total.runs).toBe(0);
    expect(total.marginUsd).toBeNull();
    expect(total.costPerCreditUsd).toBeNull();
  });
});

describe("runs priced at read time rather than at charge time", () => {
  test("are counted apart, so a total resting on today's rates says so", () => {
    // Rows charged before anything wrote `costUsdActual` still carry their tokens, so their cost
    // is arithmetic. It is arithmetic at today's prices, which is the part worth flagging.
    const row = marginRow(
      sums({ runs: 20, creditsCharged: 20, pricedRuns: 20, pricedCredits: 20, costUsd: 0.5, estimatedRuns: 18 }),
    );
    expect(row.estimatedRuns).toBe(18);
    expect(row.unpricedRuns).toBe(0);
    expect(row.costPerCreditUsd).toBeCloseTo(0.025, 6);
  });

  test("survive the total line", () => {
    const total = marginTotal([
      sums({ key: "summary", runs: 5, creditsCharged: 5, pricedRuns: 5, pricedCredits: 5, costUsd: 0.1, estimatedRuns: 5 }),
      sums({ key: "brief", runs: 5, creditsCharged: 5, pricedRuns: 5, pricedCredits: 5, costUsd: 0.1, estimatedRuns: 0 }),
    ]);
    expect(total.estimatedRuns).toBe(5);
  });
});

describe("the list rate", () => {
  test("is the on-demand rate of ten cents a credit, not a separate number that can drift", () => {
    expect(LIST_RATE_USD_PER_CREDIT).toBeCloseTo(0.1, 6);
  });
});
