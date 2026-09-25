/**
 * The Pro price labels, read from Stripe.
 *
 * The labels shown on `/pricing`, `/credits` and the billing tab live in the `BillingConfig` row so
 * customer-facing reads never call Stripe. Until an admin pressed "refresh from Stripe" on the
 * admin billing page that row did not exist, and `/pricing` printed "price shown at checkout" in
 * place of a number, which is the one thing a pricing page must not do. This module is the one
 * place that turns the configured Stripe prices into labels; the admin route uses it on demand and
 * `getBillingProPriceLabel` uses it as the fallback when the row is missing.
 */
import Stripe from "stripe";

export type ProPriceLabelSet = {
  /** Monthly Pro, e.g. "$29/mo". */
  proPriceLabel: string;
  /** Yearly Pro, e.g. "$290/yr"; null when the deployment sells monthly only. */
  proAnnualPriceLabel: string | null;
  /** The yearly price per month, e.g. "$24/mo", for "billed yearly" copy. */
  proAnnualPerMonthLabel: string | null;
};

/** "$29/mo" from a Stripe unit amount, currency and interval. */
export function formatPriceLabel(params: { unitAmount: number; currency: string; interval: string }): string {
  const { unitAmount, currency, interval } = params;
  const amount = unitAmount / 100;
  const cur = (currency || "usd").toUpperCase();
  const suffix = interval === "month" ? "/mo" : interval === "year" ? "/yr" : `/${interval}`;
  try {
    return `${new Intl.NumberFormat(undefined, { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(amount)}${suffix}`;
  } catch {
    return `$${amount.toFixed(0)}${suffix}`;
  }
}

type PriceShape = { unit_amount?: unknown; currency?: unknown; recurring?: { interval?: unknown } | null };

function readPrice(price: PriceShape): { unitAmount: number; currency: string; interval: string } | null {
  const unitAmount = typeof price.unit_amount === "number" && Number.isFinite(price.unit_amount) ? price.unit_amount : null;
  if (unitAmount === null) return null;
  const currency = typeof price.currency === "string" ? price.currency : "usd";
  const interval = typeof price.recurring?.interval === "string" ? price.recurring.interval : "month";
  return { unitAmount, currency, interval };
}

/**
 * Read the Pro price labels from the configured Stripe prices (`STRIPE_PRICE_ID`, and
 * `STRIPE_PRICE_ID_ANNUAL` when set).
 *
 * Returns null when the deployment has no Stripe key or no monthly price id: nothing to read, not
 * an error. Throws when a configured price is unusable (no `unit_amount`, or an annual price that is
 * not yearly), because that is a configuration mistake somebody has to see.
 */
export async function readProPriceLabelsFromStripe(): Promise<ProPriceLabelSet | null> {
  const stripeKey = (process.env.STRIPE_SECRET_KEY ?? "").trim();
  const priceId = (process.env.STRIPE_PRICE_ID ?? "").trim();
  if (!stripeKey || !priceId) return null;

  const stripe = new Stripe(stripeKey);
  const monthly = readPrice((await stripe.prices.retrieve(priceId)) as PriceShape);
  if (!monthly) throw new Error("Stripe price missing unit_amount");
  const proPriceLabel = formatPriceLabel(monthly);

  // The yearly price, when the deployment has one. Its per-month figure is what /pricing prints
  // under the toggle ("$24/mo, billed yearly"); rounded down so the page never overstates the saving.
  const annualPriceId = (process.env.STRIPE_PRICE_ID_ANNUAL ?? "").trim();
  let proAnnualPriceLabel: string | null = null;
  let proAnnualPerMonthLabel: string | null = null;
  if (annualPriceId) {
    const annual = readPrice((await stripe.prices.retrieve(annualPriceId)) as PriceShape);
    if (!annual || annual.interval !== "year") {
      throw new Error("STRIPE_PRICE_ID_ANNUAL must be a licensed price with interval=year");
    }
    proAnnualPriceLabel = formatPriceLabel({ ...annual, currency: annual.currency || monthly.currency });
    proAnnualPerMonthLabel = formatPriceLabel({
      unitAmount: Math.floor(annual.unitAmount / 12),
      currency: annual.currency || monthly.currency,
      interval: "month",
    });
  }

  return { proPriceLabel, proAnnualPriceLabel, proAnnualPerMonthLabel };
}
