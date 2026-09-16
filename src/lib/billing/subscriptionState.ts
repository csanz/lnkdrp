/**
 * What a workspace's Stripe subscription entitles it to.
 *
 * Until 2026-09-15 "active or trialing subscription" meant "Pro", and nine files each carried
 * their own copy of that two-line check. Pay-as-you-go broke the equation: a Free workspace that
 * adds a card gets a Stripe subscription too — one holding only the metered credits price, so
 * the meter has something to bill — and that subscription is `active` without being Pro. Every
 * place that used to ask "is the status active?" now has to ask one of two different questions:
 *
 * - **Is this workspace Pro?** (limits, 300 included credits a cycle, deep analytics) →
 *   {@link isProSubscription}: billable status AND the subscription carries the Pro price.
 * - **May this workspace be billed for usage?** (on-demand credits, the spend limit, meter
 *   reporting) → {@link isBillableSubscription}: billable status, either kind.
 *
 * `kind` is written by the Stripe webhook from the subscription's items. Rows from before the
 * field existed have no `kind`; they were all Pro, so `null` reads as Pro when billable.
 */

/** Stripe subscription statuses under which the customer can be charged. */
export function isBillableStatus(status: unknown): boolean {
  const s = typeof status === "string" ? status.trim().toLowerCase() : "";
  return s === "active" || s === "trialing";
}

export type SubscriptionKind = "pro" | "payg";

/** The two fields the questions above need; every `Subscription` row and every lean select of one fits. */
export type SubscriptionStateLike = { status?: unknown; kind?: unknown } | null | undefined;

/** `"payg"` only when the row says so; everything else (including legacy `null`) is `"pro"`. */
export function subscriptionKind(sub: SubscriptionStateLike): SubscriptionKind {
  return sub?.kind === "payg" ? "payg" : "pro";
}

/** Billable and carrying the Pro price. */
export function isProSubscription(sub: SubscriptionStateLike): boolean {
  return isBillableStatus(sub?.status) && subscriptionKind(sub) === "pro";
}

/** Billable, metered credits only — a Free workspace with a card on file. */
export function isPaygSubscription(sub: SubscriptionStateLike): boolean {
  return isBillableStatus(sub?.status) && subscriptionKind(sub) === "payg";
}

/** Billable of either kind: the workspace can be charged for on-demand credits. */
export function isBillableSubscription(sub: SubscriptionStateLike): boolean {
  return isBillableStatus(sub?.status);
}

/**
 * Mongo filter for "Pro" rows, for the crons and sweeps that query by status. Pairs with
 * `status: { $in: [...] }`; excludes pay-as-you-go rows, keeps legacy rows without `kind`.
 */
export const PRO_KIND_FILTER = { kind: { $ne: "payg" } } as const;

/**
 * Derive `kind` from a Stripe subscription's items: the Pro price present → `"pro"`; otherwise,
 * the metered credits price alone → `"payg"`; neither known price → `null` (leave the stored
 * value alone rather than guess).
 */
export function subscriptionKindFromPriceIds(params: {
  priceIds: readonly string[];
  proPriceId: string | null | undefined;
  creditsPriceId: string | null | undefined;
}): SubscriptionKind | null {
  const pro = (params.proPriceId ?? "").trim();
  const credits = (params.creditsPriceId ?? "").trim();
  const ids = params.priceIds.map((p) => p.trim()).filter(Boolean);
  if (pro && ids.includes(pro)) return "pro";
  if (credits && ids.includes(credits)) return "payg";
  return null;
}

/**
 * Default monthly spend limit when a pay-as-you-go subscription becomes billable and the
 * workspace has never set one: $10, a hundred credits. Someone who just added a card came here
 * to buy credits, so on-demand must work at once; the limit is theirs to raise on /dashboard/limits.
 */
export const PAYG_DEFAULT_SPEND_LIMIT_CENTS = 1000;
