/**
 * Billing usage aggregation helpers.
 *
 * These helpers intentionally operate on a minimal, billing-safe subset of ledger fields.
 * They must not require or expose provider/model token telemetry.
 */

export type BillingLedgerRow = {
  actionType: "summary" | "review" | "history" | "unknown";
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
  costUsdActual: number | null;
};

export type BillingIncludedRow = { label: string; credits: number; costCents: number; costLabel: string };
export type BillingOnDemandRow = { label: string; credits: number; costCents: number | null; qty: number; totalCents: number | null };

function clampNonNegInt(n: unknown): number {
  const v = typeof n === "number" ? n : typeof n === "string" ? Number(n) : NaN;
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.floor(v));
}

function centsFromUsd(usd: number): number {
  if (!Number.isFinite(usd)) return 0;
  return Math.round(Math.max(0, usd) * 100);
}

function actionLabel(a: BillingLedgerRow["actionType"]): string {
  if (a === "summary") return "Summary";
  if (a === "review") return "Review";
  if (a === "history") return "History";
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

function inferOnDemandCredits(l: BillingLedgerRow): number {
  const direct = clampNonNegInt(l.creditsFromOnDemand);
  if (direct > 0) return direct;
  // Best-effort: some legacy rows may have cost but not a populated on-demand bucket.
  if (typeof l.costUsdActual === "number" && Number.isFinite(l.costUsdActual) && l.costUsdActual > 0) {
    return clampNonNegInt(l.creditsCharged);
  }
  return 0;
}

/**
 * Returns the on-demand cost (in cents) for a billing ledger row, or null when unknown.
 *
 * Exists to keep UI aggregation logic billing-safe: we only expose cost when it is explicitly
 * present as USD on the ledger row.
 */
export function onDemandCostCentsOrNull(l: BillingLedgerRow): number | null {
  if (typeof l.costUsdActual === "number" && Number.isFinite(l.costUsdActual) && l.costUsdActual !== null) {
    return centsFromUsd(l.costUsdActual);
  }
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
  const onDemandMap = new Map<string, { label: string; credits: number; totalCents: number; qty: number; unknownCost: boolean }>();
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
    const relevant = onDemandCredits > 0 || (typeof raw.costUsdActual === "number" && raw.costUsdActual !== null);
    if (!relevant) continue;

    if (status === "refunded") {
      if (cents !== null) refundCents += cents;
      continue;
    }

    const key = (raw.modelRoute ?? "").trim() ? `model:${String(raw.modelRoute).trim()}` : `${raw.actionType}:${raw.qualityTier}`;
    const label = (raw.modelRoute ?? "").trim()
      ? String(raw.modelRoute).trim()
      : `${actionLabel(raw.actionType)} (${qualityLabel(raw.qualityTier)})`;
    const bucket = onDemandMap.get(key) ?? { label, credits: 0, totalCents: 0, qty: 0, unknownCost: false };
    bucket.credits += onDemandCredits;
    if (cents === null) bucket.unknownCost = true;
    else bucket.totalCents += cents;
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
      const knownTotalCents = clampNonNegInt(r.totalCents);
      const totalCents = r.unknownCost ? null : knownTotalCents;
      const unit = totalCents !== null && credits > 0 ? Math.floor(knownTotalCents / credits) : null;
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


