/**
 * Prepaid AI credit packs: the one-time purchases offered on `/credits`.
 *
 * Client-safe (no database imports): the credits page, the checkout route and the webhook all read
 * this one list, so a price shown is always the price charged. Prices live here rather than in the
 * Stripe catalog because Checkout is created with inline `price_data` — changing a price is a code
 * change and a deploy, not a dashboard edit that could drift from what the page shows.
 *
 * **Packs sit about 60% above Pro's effective rate, and that is the whole pricing rule.** Pro is
 * $29 for 500 credits a month, so a Pro credit costs 5.8c; a pack credit costs about 9.3c. Buying
 * packs often should feel worse than subscribing, because it is, and the credits page says so.
 *
 * They used to be far worse than that, by accident. The packs were $5/30, $9/9 and $39/300 —
 * 13c to 16.7c a credit, 30% to 67% *above the pay-as-you-go rate of 10c* and nearly three times
 * Pro's. The docstring here justified it as "Pro is $29 for 500 credits every month (~$0.10 each)",
 * which is simply wrong arithmetic, and `tests/credits/creditPacks.test.ts` guarded the rule
 * against `2900 / 300` — the stale 300-credit allowance from before Pro moved to 500. Both copies
 * of the number were wrong in the same direction, so nothing caught it.
 */

/** Pro's list price in cents, and the allowance it buys: what pack pricing is set against. */
export const PRO_LIST_PRICE_CENTS = 2900;
export const PRO_LIST_CREDITS = 500;

/** Pro's effective rate, 5.8c a credit. Packs are priced as a multiple of this. */
export const PRO_CENTS_PER_CREDIT = PRO_LIST_PRICE_CENTS / PRO_LIST_CREDITS;

/** How much dearer a pack credit is than a Pro credit. */
export const PACK_MARKUP_OVER_PRO = 1.6;

export type PurchasablePackId = "credits_75" | "credits_150" | "credits_400";
/** Ids no longer sold. Never reuse one: an in-flight Checkout still has to resolve. */
export type RetiredPackId = "credits_30" | "credits_60" | "credits_300";

export type CreditPack = {
  /** Stable id stored on each purchase and sent through Checkout metadata. */
  id: PurchasablePackId | RetiredPackId;
  credits: number;
  /** Price in US cents. */
  priceCents: number;
};

/** The packs on sale. Roughly `PRO_CENTS_PER_CREDIT * PACK_MARKUP_OVER_PRO`, rounded to whole dollars. */
export const CREDIT_PACKS: readonly CreditPack[] = [
  { id: "credits_75", credits: 75, priceCents: 700 },
  { id: "credits_150", credits: 150, priceCents: 1400 },
  { id: "credits_400", credits: 400, priceCents: 3700 },
] as const;

/**
 * Packs withdrawn from sale, kept resolvable on purpose.
 *
 * `recordPurchase` throws `Unknown credit pack` on an id it cannot find, and it runs in the Stripe
 * webhook — *after* the customer has paid. A Checkout Session opened minutes before a repricing
 * deploy still carries its old `packId`, so dropping these outright would take someone's money and
 * grant them nothing. They are not offered for sale: `findPurchasablePack` is what the checkout
 * route validates against.
 */
export const RETIRED_CREDIT_PACKS: readonly CreditPack[] = [
  { id: "credits_30", credits: 30, priceCents: 500 },
  { id: "credits_60", credits: 60, priceCents: 900 },
  { id: "credits_300", credits: 300, priceCents: 3900 },
] as const;

/** Purchased credits expire this many months after the purchase, whatever is left of them. */
export const PURCHASED_CREDITS_EXPIRY_MONTHS = 12;

/** Currency for every pack (Checkout `price_data.currency`). */
export const CREDIT_PACK_CURRENCY = "usd";

/**
 * Look up a pack by id for **recording** a purchase, retired ids included.
 *
 * `null` for anything unknown: never trust a client-sent id.
 */
export function findCreditPack(id: unknown): CreditPack | null {
  if (typeof id !== "string") return null;
  return CREDIT_PACKS.find((p) => p.id === id) ?? RETIRED_CREDIT_PACKS.find((p) => p.id === id) ?? null;
}

/**
 * Look up a pack by id for **selling** one. Retired ids do not resolve here, so a stale page or a
 * replayed request cannot open a Checkout at last week's price.
 */
export function findPurchasablePack(id: unknown): CreditPack | null {
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
