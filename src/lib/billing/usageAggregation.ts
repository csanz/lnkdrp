/**
 * Billing usage aggregation helpers.
 *
 * These helpers intentionally operate on a minimal, billing-safe subset of ledger fields.
 * They must not require or expose provider/model token telemetry.
 *
 * In particular they never read `costUsdActual`. Since 2026-09-26 that field is written, by
 * `markLedgerCharged`, and it holds what the run cost *us* at the provider. It is not what the
 * customer is charged: on-demand has a single price, `USD_CENTS_PER_CREDIT` a credit, and that is
 * what `/api/billing/spend` reports and what Stripe meters. Pricing an invoice line from our
 * provider cost would bill a different number on every row and would drag allowance-funded runs,
 * which cost us money and charge the customer nothing extra, onto the on-demand table.
 */
import { USD_CENTS_PER_CREDIT } from "./pricing";

export type BillingLedgerRow = {
  actionType: "summary" | "review" | "history" | "brief" | "unknown";
  qualityTier: "basic" | "standard" | "advanced";
  modelRoute: string | null;
  status: "charged" | "refunded";
  /**
   * Optional pre-aggregated count for this row.
   *
   * When present, aggregation will treat this row as representing `qty` ledger entries.
   * When absent, defaults to 1 (normal per-ledger rows).
   */
  qty?: number;
  creditsCharged: number;
  creditsFromTrial: number;
  creditsFromSubscription: number;
  creditsFromPurchased: number;
  creditsFromOnDemand: number;
  /**
   * Our provider cost, if the caller happens to carry it. **Read by nothing in this file.**
   *
   * Declared, rather than omitted, so that the ban is stated where a future reader will look
   * instead of being an absence they have to notice. `/api/billing/usage` does not project it; a
   * caller that passes it anyway is ignored, and `billingUsageAggregation.test.ts` pins that.
   */
  costUsdActual?: number | null;
};

export type BillingIncludedRow = { label: string; credits: number; costCents: number; costLabel: string };
export type BillingOnDemandRow = { label: string; credits: number; costCents: number | null; qty: number; totalCents: number | null };

function clampNonNegInt(n: unknown): number {
  const v = typeof n === "number" ? n : typeof n === "string" ? Number(n) : NaN;
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.floor(v));
}

function actionLabel(a: BillingLedgerRow["actionType"]): string {
  if (a === "summary") return "Summary";
  if (a === "review") return "AI review";
  if (a === "history") return "AI compare";
  if (a === "brief") return "Visit brief";
  return "Unknown";
}

function qualityLabel(q: BillingLedgerRow["qualityTier"]): string {
  if (q === "basic") return "Basic";
  if (q === "standard") return "Standard";
  return "Advanced";
}

function includedCredits(l: BillingLedgerRow): number {
  return (
    clampNonNegInt(l.creditsFromSubscription) +
    clampNonNegInt(l.creditsFromTrial) +
    clampNonNegInt(l.creditsFromPurchased)
  );
}

/**
 * On-demand credits for a row: the `creditsFromOnDemand` bucket, and nothing else.
 *
 * This used to fall back to `creditsCharged` when the row carried a `costUsdActual`, on the
 * reasoning that a cost implied on-demand. That was safe only while nothing wrote the field. Now
 * that every settled run records one, the fallback would read an allowance-funded run - a Pro
 * customer spending credits they already paid for in their subscription - as on-demand overage and
 * invoice it a second time. The bucket split is the only thing that says who funded a credit.
 */
function inferOnDemandCredits(l: BillingLedgerRow): number {
  return clampNonNegInt(l.creditsFromOnDemand);
}

/**
 * Returns the on-demand cost (in cents) for a billing ledger row, or null when there is none.
 *
 * On-demand is not priced per token: it is billed at a flat USD_CENTS_PER_CREDIT per credit, the
 * same arithmetic `/api/billing/spend` uses for the Limits tab and the same figure Stripe meters.
 * Credits are therefore an exact answer here, not a fabricated one.
 *
 * It once returned a cost only for a row carrying USD in `costUsdActual`. Nothing wrote that field
 * then, so it returned null for every row and the billing table printed "Not available" against
 * usage the customer was really invoiced for. The field is written now, but it is our provider
 * cost, so reading it would swap an exact invoice line for a number the customer was never quoted.
 * Null means what it says: a row with no on-demand credits.
 */
export function onDemandCostCentsOrNull(l: BillingLedgerRow): number | null {
  const credits = inferOnDemandCredits(l);
  if (credits > 0) return credits * USD_CENTS_PER_CREDIT;
  return null;
}

/**
 * Aggregates included and on-demand usage from billing-safe ledger rows.
 *
 * Exists to drive billing UI tables without exposing raw model/token telemetry.
 * Assumptions: `ledgers` contains charged and refunded rows; refunds are represented as adjustments.
 */
export function aggregateBillingUsage(params: {
  ledgers: BillingLedgerRow[];
  onDemandLimitCents: number;
}): {
  included: { rows: BillingIncludedRow[]; total: BillingIncludedRow };
  onDemand: {
    usedCents: number;
    limitCents: number;
    rows: BillingOnDemandRow[];
    adjustments: Array<{ description: string; totalCents: number }>;
    subtotalCents: number;
  };
} {
  const limitCents = clampNonNegInt(params.onDemandLimitCents);

  const includedMap = new Map<string, { label: string; credits: number }>();
  const onDemandMap = new Map<string, { label: string; credits: number; totalCents: number; qty: number }>();
  let refundCents = 0;

  for (const raw of params.ledgers) {
    const status = raw.status;
    const qty = clampNonNegInt(raw.qty ?? 1);

    // Included usage (credits-first): charged only. (Refunds are handled as on-demand adjustments below.)
    if (status === "charged") {
      const inc = includedCredits(raw);
      if (inc > 0) {
        const key = `${raw.actionType}:${raw.qualityTier}`;
        const label = `${actionLabel(raw.actionType)} (${qualityLabel(raw.qualityTier)})`;
        const bucket = includedMap.get(key) ?? { label, credits: 0 };
        bucket.credits += inc;
        includedMap.set(key, bucket);
      }
    }

    // On-demand usage: charged rows become line items; refunded rows become adjustments.
    const onDemandCredits = inferOnDemandCredits(raw);
    const cents = onDemandCostCentsOrNull(raw);
    // On-demand credits are the only thing that puts a row on this table. A stored `costUsdActual`
    // used to qualify a row too, which now lets every allowance-funded run in.
    if (onDemandCredits <= 0) continue;

    if (status === "refunded") {
      if (cents !== null) refundCents += cents;
      continue;
    }

    const key = (raw.modelRoute ?? "").trim() ? `model:${String(raw.modelRoute).trim()}` : `${raw.actionType}:${raw.qualityTier}`;
    const label = (raw.modelRoute ?? "").trim()
      ? String(raw.modelRoute).trim()
      : `${actionLabel(raw.actionType)} (${qualityLabel(raw.qualityTier)})`;
    const bucket = onDemandMap.get(key) ?? { label, credits: 0, totalCents: 0, qty: 0 };
    bucket.credits += onDemandCredits;
    // `cents` is non-null for every row that got this far: it is priced from the same credits the
    // guard above required. The check is the type's, not a real branch.
    if (cents !== null) bucket.totalCents += cents;
    bucket.qty += qty;
    onDemandMap.set(key, bucket);
  }

  const includedRows: BillingIncludedRow[] = [...includedMap.values()]
    .sort((a, b) => b.credits - a.credits)
    .map((r) => ({ label: r.label, credits: clampNonNegInt(r.credits), costCents: 0, costLabel: "Included" }));
  const includedTotalCredits = includedRows.reduce((s, r) => s + clampNonNegInt(r.credits), 0);
  const includedTotal: BillingIncludedRow = { label: "Total", credits: includedTotalCredits, costCents: 0, costLabel: "Included" };

  const onDemandRows: BillingOnDemandRow[] = [...onDemandMap.values()]
    .sort((a, b) => b.totalCents - a.totalCents)
    .map((r) => {
      const credits = clampNonNegInt(r.credits);
      const totalCents = clampNonNegInt(r.totalCents);
      const unit = credits > 0 ? Math.floor(totalCents / credits) : null;
      return { label: r.label, credits, costCents: unit, qty: clampNonNegInt(r.qty), totalCents };
    });

  const subtotalCents = onDemandRows.reduce((s, r) => s + clampNonNegInt(r.totalCents ?? 0), 0);
  const adjustments =
    refundCents > 0 ? ([{ description: "Refunds", totalCents: -clampNonNegInt(refundCents) }] as const) : [];
  const usedCents = Math.max(0, subtotalCents - clampNonNegInt(refundCents));

  return {
    included: { rows: includedRows, total: includedTotal },
    onDemand: { usedCents, limitCents, rows: onDemandRows, adjustments: [...adjustments], subtotalCents },
  };
}


