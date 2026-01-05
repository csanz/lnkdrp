import { createHash } from "crypto";

export type StripeReportableLedger = {
  id: string;
  workspaceId: string;
  creditsFromOnDemand: number;
};

export function batchIdempotencyKey(params: { subscriptionItemId: string; ledgerIds: string[] }): string {
  const ids = [...params.ledgerIds].sort();
  const h = createHash("sha256");
  h.update(params.subscriptionItemId);
  h.update("|");
  h.update(ids.join(","));
  return `credits-report:${h.digest("hex").slice(0, 48)}`;
}

/**
 * Group reportable ledgers by Stripe subscription item id and compute a quantity in credits.
 *
 * IMPORTANT: Stripe reporting is **on-demand only** (overage), i.e. `creditsFromOnDemand`.
 */
export function groupOnDemandLedgersForStripe(params: {
  ledgers: StripeReportableLedger[];
  subscriptionItemIdByWorkspaceId: Map<string, string>;
}): Map<string, { ledgerIds: string[]; quantity: number }> {
  const grouped = new Map<string, { ledgerIds: string[]; quantity: number }>();

  for (const l of params.ledgers) {
    const itemId = params.subscriptionItemIdByWorkspaceId.get(l.workspaceId);
    if (!itemId) continue;
    const qty = typeof l.creditsFromOnDemand === "number" ? Math.max(0, Math.floor(l.creditsFromOnDemand)) : 0;
    if (qty <= 0) continue;
    const bucket = grouped.get(itemId) ?? { ledgerIds: [], quantity: 0 };
    bucket.ledgerIds.push(l.id);
    bucket.quantity += qty;
    grouped.set(itemId, bucket);
  }

  return grouped;
}


