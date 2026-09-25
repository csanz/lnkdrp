/**
 * What a workspace's Stripe subscription entitles it to.
 *
 * Until 2026-09-15 "active or trialing subscription" meant "Pro", and nine files each carried
 * their own copy of that two-line check. Pay-as-you-go broke the equation: a Free workspace that
 * adds a card gets a Stripe subscription too — one holding only the metered credits price, so
 * the meter has something to bill — and that subscription is `active` without being Pro. Every
 * place that used to ask "is the status active?" now has to ask one of two different questions:
 *
 * - **Is this workspace Pro?** (limits, 500 included credits a cycle, deep analytics) →
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

/**
 * Stripe statuses under which the subscription still exists and may bill again: everything
 * except `canceled` and `incomplete_expired` (and our own `free`, which is not a Stripe status).
 *
 * This is the question Checkout has to ask, not {@link isBillableStatus}. A `past_due` or `unpaid`
 * subscription is not Pro (the workspace is Free while the card fails), but Stripe is still
 * retrying it, and a second Checkout would create a second subscription on the same customer.
 * When the first one then recovers, the customer is billed twice and the row tracks only one.
 */
export function isOpenStatus(status: unknown): boolean {
  const s = typeof status === "string" ? status.trim().toLowerCase() : "";
  return s === "active" || s === "trialing" || s === "past_due" || s === "unpaid" || s === "incomplete" || s === "paused";
}

/** The workspace has a Stripe subscription that is not finished, billable or not. */
export function hasOpenSubscription(sub: SubscriptionStateLike): boolean {
  return isOpenStatus(sub?.status);
}

export type SubscriptionKind = "pro" | "payg";

/**
 * How often the Pro price bills. `"year"` is the annual plan (twelve months for the price of ten):
 * the same Pro, with two differences that follow from Stripe refusing to put a monthly metered
 * price on a yearly subscription. An annual workspace has no on-demand credits, and it may buy
 * credit packs instead, which a monthly Pro workspace may not. Rows from before the field existed
 * are monthly, so `null` reads as `"month"`.
 */
export type SubscriptionInterval = "month" | "year";

/** The fields the questions above need; every `Subscription` row and every lean select of one fits. */
export type SubscriptionStateLike = { status?: unknown; kind?: unknown; interval?: unknown } | null | undefined;

/** `"year"` only when the row says so; everything else (including legacy `null`) is monthly. */
export function subscriptionInterval(sub: SubscriptionStateLike): SubscriptionInterval {
  return sub?.interval === "year" ? "year" : "month";
}

/** Billable, on the Pro price, billed yearly. */
export function isAnnualProSubscription(sub: SubscriptionStateLike): boolean {
  return isProSubscription(sub) && subscriptionInterval(sub) === "year";
}

/**
 * May this workspace turn on on-demand credits? Monthly Pro only: the metered price that bills
 * on-demand usage is a monthly line item, and Stripe will not attach one to a yearly subscription.
 */
export function onDemandEligible(sub: SubscriptionStateLike): boolean {
  return isProSubscription(sub) && subscriptionInterval(sub) !== "year";
}

/**
 * May this workspace buy a credit pack? Free always; annual Pro too, since packs are its only way
 * past the monthly credits. Monthly Pro may not: on-demand is cheaper per credit, so a pack would
 * only cost it more.
 */
export function creditPacksAllowed(sub: SubscriptionStateLike): boolean {
  return !isProSubscription(sub) || subscriptionInterval(sub) === "year";
}

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
 * Derive `kind` from a Stripe subscription's items: either Pro price (monthly or annual) present
 * → `"pro"`; otherwise, the metered credits price alone → `"payg"`; neither known price → `null`
 * (leave the stored value alone rather than guess).
 */
export function subscriptionKindFromPriceIds(params: {
  priceIds: readonly string[];
  proPriceId: string | null | undefined;
  proAnnualPriceId?: string | null | undefined;
  creditsPriceId: string | null | undefined;
}): SubscriptionKind | null {
  const pro = (params.proPriceId ?? "").trim();
  const annual = (params.proAnnualPriceId ?? "").trim();
  const credits = (params.creditsPriceId ?? "").trim();
  const ids = params.priceIds.map((p) => p.trim()).filter(Boolean);
  if (pro && ids.includes(pro)) return "pro";
  if (annual && ids.includes(annual)) return "pro";
  if (credits && ids.includes(credits)) return "payg";
  return null;
}

/**
 * Derive the billing interval from a Stripe subscription's items. The licensed (non-metered)
 * item's `recurring.interval` decides; a metered item is always monthly and says nothing about the
 * plan. `null` when no item carries an interval, so the stored value is left alone.
 */
export function subscriptionIntervalFromItems(
  items: ReadonlyArray<{ price?: { recurring?: { interval?: unknown; usage_type?: unknown } | null } | null } | null | undefined>,
): SubscriptionInterval | null {
  for (const it of items) {
    const rec = it?.price?.recurring;
    if (!rec || rec.usage_type === "metered") continue;
    if (rec.interval === "year") return "year";
    if (rec.interval === "month") return "month";
  }
  return null;
}

/**
 * Default monthly spend limit when a pay-as-you-go subscription becomes billable and the
 * workspace has never set one: $10, a hundred credits. Someone who just added a card came here
 * to buy credits, so on-demand must work at once; the limit is theirs to raise on /dashboard/limits.
 */
export const PAYG_DEFAULT_SPEND_LIMIT_CENTS = 1000;
