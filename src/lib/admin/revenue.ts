/**
 * Shaping for the admin revenue panel: pure functions over what the database already holds.
 *
 * Three sources, and they are not equally solid — the UI says which is which:
 * - **Subscriptions** give run-rate, not receipts: active Pro workspaces × the Pro price. Nobody has
 *   paid this yet; it is what renews if nothing changes.
 * - **Credit packs** are real charges: `CreditPurchase.amountCents`, written when Stripe confirmed.
 * - **On-demand** is metered usage priced at `USD_CENTS_PER_CREDIT` and reported to Stripe by a
 *   job. It is an estimate of what will be invoiced, not an invoice.
 * Stripe invoices are not stored locally, so none of this is "money received".
 */
import { USD_CENTS_PER_CREDIT } from "@/lib/billing/pricing";

export type RevenueDay = { day: string; packCents: number; onDemandCents: number };

export type RevenueSubscriptions = {
  proActive: number;
  /** Pro, still paid for, but set to end at the period end. */
  proEnding: number;
  payg: number;
  /** Workspaces with a subscription row that is neither Pro nor pay-as-you-go (past_due, incomplete…). */
  otherBillable: number;
  free: number;
};

export type RevenueSummary = {
  /** Monthly run-rate from Pro subscriptions, in cents; null when the Pro price is unknown. */
  mrrCents: number | null;
  /** Of that run-rate, the part already cancelled and ending. */
  endingCents: number | null;
  packCents: number;
  onDemandCents: number;
  /** Packs + on-demand over the window: what was actually charged or metered, no run-rate. */
  chargedCents: number;
  /** The same figure for the window before this one, for a trend. */
  previousChargedCents: number;
};

/** Credits billed on demand, priced the way the workspace is billed. */
export function onDemandCents(credits: number): number {
  return Math.round(Math.max(0, credits) * USD_CENTS_PER_CREDIT);
}

/**
 * A price label as stored by the billing config ("$29/mo", "$29.00 per month") as cents.
 * Returns null rather than guessing when the label is not a plain currency amount.
 */
export function priceLabelToCents(label: string | null | undefined): number | null {
  const raw = (label ?? "").trim();
  if (!raw) return null;
  // Thousands separators are grouping, not decimals: "$1,199/mo" is 119900 cents, not 119. Only a
  // dot followed by one or two digits is a fraction.
  const m = raw.match(/(\d[\d,]*)(?:\.(\d{1,2}))?/);
  if (!m) return null;
  const whole = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(whole)) return null;
  const fraction = m[2] ? Number(m[2].padEnd(2, "0")) : 0;
  if (!Number.isFinite(fraction)) return null;
  return whole * 100 + fraction;
}

/** Fill every day in the window, so a gap in sales reads as a gap and not as a missing point. */
export function fillDays(days: RevenueDay[], since: Date, until: Date): RevenueDay[] {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const out: RevenueDay[] = [];
  const cursor = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()));
  const end = Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), until.getUTCDate());
  while (cursor.getTime() <= end) {
    const key = cursor.toISOString().slice(0, 10);
    out.push(byDay.get(key) ?? { day: key, packCents: 0, onDemandCents: 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/** Percentage change against the previous window; null when there is nothing to compare to. */
export function trendPct(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

/** Cents as a compact money string for a tile: $1,240 (no cents above $100, which only adds noise). */
export function fmtMoney(cents: number | null | undefined): string {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return "—";
  const dollars = cents / 100;
  return dollars >= 100 || Number.isInteger(dollars)
    ? `$${Math.round(dollars).toLocaleString("en-US")}`
    : `$${dollars.toFixed(2)}`;
}
