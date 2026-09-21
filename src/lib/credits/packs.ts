/**
 * Prepaid AI credit packs: the one-time purchases offered on `/credits`.
 *
 * Client-safe (no database imports): the credits page, the checkout route and the webhook all read
 * this one list, so a price shown is always the price charged. Priced above Pro on purpose — Pro is
 * $29 for 500 credits every month (~$0.10 each) — so the page can honestly point people at Pro when
 * they buy often. Prices live here rather than in the Stripe catalog: Checkout is created with
 * inline `price_data`, so changing a price is a code change and a deploy, not a dashboard edit that
 * could drift from what the page shows.
 */

export type CreditPack = {
  /** Stable id stored on each purchase and sent through Checkout metadata. */
  id: "credits_30" | "credits_60" | "credits_300";
  credits: number;
  /** Price in US cents. */
  priceCents: number;
};

export const CREDIT_PACKS: readonly CreditPack[] = [
  { id: "credits_30", credits: 30, priceCents: 500 },
  { id: "credits_60", credits: 60, priceCents: 900 },
  { id: "credits_300", credits: 300, priceCents: 3900 },
] as const;

/** Purchased credits expire this many months after the purchase, whatever is left of them. */
export const PURCHASED_CREDITS_EXPIRY_MONTHS = 12;

/** Currency for every pack (Checkout `price_data.currency`). */
export const CREDIT_PACK_CURRENCY = "usd";

/** Look up a pack by id; `null` for anything not in the list (never trust a client-sent id). */
export function findCreditPack(id: unknown): CreditPack | null {
  return typeof id === "string" ? (CREDIT_PACKS.find((p) => p.id === id) ?? null) : null;
}

/** "$5", "$39", "$4.50". */
export function formatPackPrice(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/** Per-credit price rounded to the cent, e.g. "$0.17". */
export function formatPerCredit(pack: CreditPack): string {
  return `$${(pack.priceCents / pack.credits / 100).toFixed(2)}`;
}

/** Expiry date for a purchase made at `purchasedAt` (calendar months, UTC). */
export function purchaseExpiresAt(purchasedAt: Date): Date {
  const d = new Date(purchasedAt.getTime());
  d.setUTCMonth(d.getUTCMonth() + PURCHASED_CREDITS_EXPIRY_MONTHS);
  return d;
}

export type PurchaseLot = { id: string; credits: number; purchasedAt: Date; expiresAt: Date };

/**
 * Decide how many credits each due purchase takes with it when it expires.
 *
 * The balance keeps one `purchasedCreditsRemaining` counter, not a counter per purchase, so this
 * works out each purchase's unspent part by spending oldest-first: whatever is left of the
 * counter belongs to the newest purchases first. A purchase expiring now keeps at most what is left
 * after every newer, still-live purchase has been fully counted. Refunded runs can push the counter
 * above the sum of live purchases; the per-purchase clamp keeps an expiry from ever removing more
 * than that purchase added.
 *
 * `lots` are all purchases that have not expired yet (due or not). Returns the credits to remove
 * per due purchase, oldest first, and the counter afterwards.
 */
export function planPurchaseExpiry(params: {
  remaining: number;
  lots: readonly PurchaseLot[];
  now: Date;
}): { expire: Array<{ id: string; credits: number }>; remainingAfter: number } {
  let remaining = Math.max(0, Math.floor(params.remaining));
  const live = [...params.lots].sort((a, b) => a.purchasedAt.getTime() - b.purchasedAt.getTime());
  const expire: Array<{ id: string; credits: number }> = [];
  while (live.length && live[0].expiresAt.getTime() <= params.now.getTime()) {
    const lot = live.shift() as PurchaseLot;
    const newer = live.reduce((sum, l) => sum + Math.max(0, Math.floor(l.credits)), 0);
    const unspent = Math.max(0, Math.min(Math.floor(lot.credits), remaining - newer));
    remaining -= unspent;
    expire.push({ id: lot.id, credits: unspent });
  }
  return { expire, remainingAfter: remaining };
}
