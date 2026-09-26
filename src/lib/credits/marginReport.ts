/**
 * What an AI action charged against what it cost, for a window.
 *
 * Exists because a margin is not a number anyone had. The price of a run is fixed by
 * `creditsForRun` and the cost is whatever the model happened to burn, and until the ledger started
 * carrying `costUsdActual` the two were never in the same place. A feature can be sold at five
 * credits and cost four cents, or sold at one credit and cost six, and nothing in the product would
 * have said so.
 *
 * The shaping is kept here, free of Mongo and of React, so the arithmetic can be read and tested on
 * its own: the admin route does the aggregation and hands these functions plain numbers, and the
 * page imports the same types.
 *
 * Two honesty rules the shapes enforce, because a margin report that quietly rounds either one is
 * worse than no report:
 * - Runs whose cost could not be established are counted and reported, never treated as free. Every
 *   ratio below is computed over the priced runs alone, so `costPerCreditUsd` is the cost per
 *   credit of the runs we can actually price and not a total diluted by the ones we cannot.
 * - The revenue side is the on-demand list rate, which is a ceiling and not what most runs earn.
 *   Most credits are spent out of a Pro allowance or a starter grant that was never sold by the
 *   credit. `listRateUsd` is named for what it is so no reader mistakes it for realized revenue.
 */
import { USD_CENTS_PER_CREDIT } from "@/lib/billing/pricing";

/** The raw sums one aggregation bucket produces, before any ratio is taken. */
export type MarginBucketSums = {
  /** What the bucket is: an action type, a model route, or whatever the caller grouped by. */
  key: string;
  runs: number;
  creditsCharged: number;
  /** Runs in this bucket carrying a `costUsdActual`. The rest are counted, not guessed at. */
  pricedRuns: number;
  /** Credits charged by the priced runs alone, so cost and credits describe the same runs. */
  pricedCredits: number;
  costUsd: number;
  /**
   * How many of `pricedRuns` were priced when the report was read rather than when they were
   * charged.
   *
   * Nothing wrote `costUsdActual` before 2026-09-26, but those rows do carry their tokens and the
   * model that ran, so their cost is arithmetic and not a guess. Pricing them at read time is what
   * makes this report useful before a month of new traffic accumulates. It is counted separately
   * because it is priced at today's rates: a row charged under a provider price that has since
   * changed is priced wrongly, and only this number says how much of the total that could be.
   * Nothing is written back to the row.
   */
  estimatedRuns: number;
  promptTokens: number;
  completionTokens: number;
};

/** One row of the margin table: the sums, plus what they imply. */
export type MarginRow = MarginBucketSums & {
  /** Runs with no cost on the row: no usage reported, or a model the price table does not know. */
  unpricedRuns: number;
  /** Our cost per credit charged, over the priced runs. Null when nothing in the bucket is priced. */
  costPerCreditUsd: number | null;
  /** What those credits would earn at the on-demand list rate. A ceiling, not realized revenue. */
  listRateUsd: number;
  /** `listRateUsd` minus `costUsd`. Null when nothing in the bucket is priced. */
  marginUsd: number | null;
  /** Margin as a share of `listRateUsd`, 0 to 1. Null when nothing is priced or nothing was charged. */
  marginRatio: number | null;
  /** Average cost of one run in this bucket, over the priced runs. Null when none are priced. */
  costPerRunUsd: number | null;
};

/** What one credit sells for at the on-demand list rate, in US dollars. The ceiling, per the file note. */
export const LIST_RATE_USD_PER_CREDIT = USD_CENTS_PER_CREDIT / 100;

/** Guard a divisor: a ratio over zero is not infinity, it is "no answer yet". */
function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/**
 * Turn one bucket's sums into a table row.
 *
 * Exported so the route, the tests and any later report share one definition of what "margin"
 * means here, rather than three subtly different divisions.
 */
export function marginRow(sums: MarginBucketSums): MarginRow {
  const listRateUsd = sums.pricedCredits * LIST_RATE_USD_PER_CREDIT;
  const priced = sums.pricedRuns > 0;
  const marginUsd = priced ? listRateUsd - sums.costUsd : null;
  return {
    ...sums,
    unpricedRuns: Math.max(0, sums.runs - sums.pricedRuns),
    costPerCreditUsd: priced ? ratio(sums.costUsd, sums.pricedCredits) : null,
    listRateUsd,
    marginUsd,
    marginRatio: marginUsd === null ? null : ratio(marginUsd, listRateUsd),
    costPerRunUsd: priced ? ratio(sums.costUsd, sums.pricedRuns) : null,
  };
}

/** Add every bucket's sums together under one key, for the table's total line. */
export function marginTotal(buckets: readonly MarginBucketSums[], key = "all"): MarginRow {
  const sum: MarginBucketSums = {
    key,
    runs: 0,
    creditsCharged: 0,
    pricedRuns: 0,
    pricedCredits: 0,
    costUsd: 0,
    estimatedRuns: 0,
    promptTokens: 0,
    completionTokens: 0,
  };
  for (const b of buckets) {
    sum.runs += b.runs;
    sum.creditsCharged += b.creditsCharged;
    sum.pricedRuns += b.pricedRuns;
    sum.pricedCredits += b.pricedCredits;
    sum.costUsd += b.costUsd;
    sum.estimatedRuns += b.estimatedRuns;
    sum.promptTokens += b.promptTokens;
    sum.completionTokens += b.completionTokens;
  }
  return marginRow(sum);
}

/**
 * Total AI-run spend in the window, read from the `AiRun` log rather than the ledger.
 *
 * **This is every run, billed and unbilled alike, and it overlaps the margin table's `costUsd`
 * almost entirely.** It is not an addend: adding it to a table total double counts. It is here as
 * a second, independent measure of the same spend, and as the only place the runs the ledger
 * cannot see show up at all - a failed run had its credit refunded and its ledger row never
 * received telemetry, and a recipient's upload or an agent's own summary is recorded at zero
 * credits by design.
 *
 * It says "every run" rather than "the unbilled ones" because it cannot say the latter. Separating
 * them needs a link between the two collections, and there is none: `CreditLedger` carries no
 * `aiRunId` and `AiRun` carries no `creditLedgerId`. Until one of them does, the honest number is
 * the total, and the shortfall against the ledger's own cost is the closest thing to an unbilled
 * figure this report can offer.
 *
 * `failedRuns` and `failedCostUsd` *are* filtered, on `status`, and are genuinely unbilled: those
 * runs were refunded.
 */
export type AllAiRunSpend = {
  /** Every AiRun row in the window, whatever it charged. */
  runs: number;
  /** How many of them carry a cost. The rest are counted, never treated as free. */
  pricedRuns: number;
  /** Summed `costUsdActual` over every run, billed included. Overlaps the margin table's cost. */
  costUsd: number;
  /** Runs that ended in `failed`. Their credit was refunded, so this spend really is unbilled. */
  failedRuns: number;
  /** Summed cost of those failed runs. A subset of `costUsd`. */
  failedCostUsd: number;
};
