import { createHash } from "crypto";

export type StripeReportableLedger = {
  id: string;
  workspaceId: string;
  creditsFromOnDemand: number;
};

/**
 * Metered "AI credits" Stripe price id.
 *
 * Canonical env var is `STRIPE_AI_CREDITS_PRICE_ID`; `STRIPE_USAGE_PRICE_ID` is accepted as a legacy alias.
 * Returns `null` when neither is configured (metered billing disabled).
 */
export function getAiCreditsPriceId(): string | null {
  const canonical = (process.env.STRIPE_AI_CREDITS_PRICE_ID ?? "").trim();
  if (canonical) return canonical;
  const legacy = (process.env.STRIPE_USAGE_PRICE_ID ?? "").trim();
  return legacy || null;
}

/** Default Stripe Billing Meter `event_name` used when reporting AI credits. */
export const DEFAULT_CREDITS_METER_EVENT_NAME = "ai_credits";

/** Stripe Billing Meter `event_name` for AI credits (`STRIPE_CREDITS_METER_EVENT_NAME`, default `ai_credits`). */
export function getCreditsMeterEventName(): string {
  const v = (process.env.STRIPE_CREDITS_METER_EVENT_NAME ?? "").trim();
  return v || DEFAULT_CREDITS_METER_EVENT_NAME;
}

/** How long a claim (`reportClaimedAt`) is honoured before another run may re-claim the rows. */
export const REPORT_CLAIM_TTL_MS = 30 * 60 * 1000;

/**
 * Deterministic batch id for a set of ledger rows reported against one Stripe customer.
 *
 * Used both as the ledger `reportBatchId` claim marker and as the meter event `identifier`
 * (Stripe de-duplicates identifiers within a rolling 24h window), so a retried run that
 * re-reports the same claimed rows cannot double count.
 */
export function batchIdempotencyKey(params: { stripeCustomerId: string; ledgerIds: string[] }): string {
  const ids = [...params.ledgerIds].sort();
  const h = createHash("sha256");
  h.update(params.stripeCustomerId);
  h.update("|");
  h.update(ids.join(","));
  return `credits-report:${h.digest("hex").slice(0, 48)}`;
}

/**
 * Group reportable ledgers by Stripe customer id and compute a quantity in credits.
 *
 * IMPORTANT: Stripe reporting is **on-demand only** (overage), i.e. `creditsFromOnDemand`.
 * Meter events are keyed by `stripe_customer_id`, so grouping is per customer (not per subscription item).
 */
export function groupOnDemandLedgersForStripe(params: {
  ledgers: StripeReportableLedger[];
  stripeCustomerIdByWorkspaceId: Map<string, string>;
}): Map<string, { ledgerIds: string[]; quantity: number }> {
  const grouped = new Map<string, { ledgerIds: string[]; quantity: number }>();

  for (const l of params.ledgers) {
    const customerId = params.stripeCustomerIdByWorkspaceId.get(l.workspaceId);
    if (!customerId) continue;
    const qty = typeof l.creditsFromOnDemand === "number" ? Math.max(0, Math.floor(l.creditsFromOnDemand)) : 0;
    if (qty <= 0) continue;
    const bucket = grouped.get(customerId) ?? { ledgerIds: [], quantity: 0 };
    bucket.ledgerIds.push(l.id);
    bucket.quantity += qty;
    grouped.set(customerId, bucket);
  }

  return grouped;
}

export type StripeClaimedLedger = StripeReportableLedger & { reportBatchId: string };

/**
 * Group rows that still carry a claim (`reportBatchId`) but were never marked reported.
 *
 * A crashed run between REPORT and MARK leaves such rows behind. They must be re-sent under the
 * **same** `reportBatchId` (= Stripe meter event `identifier`, de-duplicated by Stripe), never
 * re-batched with other rows: a new batch id would be a new identifier and count the credits twice.
 *
 * Rows whose workspace has no Stripe customer mapping are skipped (and left claimed) so they can
 * be replayed once the mapping is back; they are never folded into a fresh batch.
 */
export function groupClaimedLedgersByBatch(params: {
  ledgers: StripeClaimedLedger[];
  stripeCustomerIdByWorkspaceId: Map<string, string>;
}): Map<string, { stripeCustomerId: string; ledgerIds: string[]; quantity: number }> {
  const grouped = new Map<string, { stripeCustomerId: string; ledgerIds: string[]; quantity: number }>();

  for (const l of params.ledgers) {
    const batchId = typeof l.reportBatchId === "string" ? l.reportBatchId.trim() : "";
    if (!batchId) continue;
    const customerId = params.stripeCustomerIdByWorkspaceId.get(l.workspaceId);
    if (!customerId) continue;
    const qty = typeof l.creditsFromOnDemand === "number" ? Math.max(0, Math.floor(l.creditsFromOnDemand)) : 0;
    const bucket = grouped.get(batchId) ?? { stripeCustomerId: customerId, ledgerIds: [], quantity: 0 };
    // A batch is always claimed for exactly one customer; ignore inconsistent rows defensively.
    if (bucket.stripeCustomerId !== customerId) continue;
    bucket.ledgerIds.push(l.id);
    bucket.quantity += qty;
    grouped.set(batchId, bucket);
  }

  return grouped;
}

/**
 * Build the Stripe Billing Meter event params for one reported batch.
 *
 * `value` must be a string per Stripe's meter payload contract.
 */
export function buildMeterEventParams(params: {
  eventName: string;
  stripeCustomerId: string;
  credits: number;
  identifier: string;
  timestampUnixSeconds?: number;
}): {
  event_name: string;
  payload: { stripe_customer_id: string; value: string };
  identifier: string;
  timestamp?: number;
} {
  const credits = Math.max(0, Math.floor(params.credits));
  return {
    event_name: params.eventName,
    payload: { stripe_customer_id: params.stripeCustomerId, value: String(credits) },
    identifier: params.identifier,
    ...(typeof params.timestampUnixSeconds === "number" ? { timestamp: params.timestampUnixSeconds } : {}),
  };
}
