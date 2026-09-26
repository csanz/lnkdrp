/**
 * Pure shaping and anomaly rules for the admin credits view (`/a/credits`).
 *
 * Kept free of Mongo and of React so the rules that decide "this row looks wrong" can be read and
 * tested on their own: the routes under `/api/admin/credits/*` do the querying and call these with
 * plain numbers, and the page imports the same formatters.
 *
 * The credit constants are passed in as {@link CreditRuleLimits} rather than imported: the modules
 * that own them (`@/lib/credits/grants`, `@/lib/credits/creditService`) pull in mongoose, and this
 * module is also loaded by the client page. The routes hand over the real values, so a rule can
 * never drift from the number the product actually enforces.
 */
import { isPaygSubscription, isProSubscription, type SubscriptionStateLike } from "@/lib/billing/subscriptionState";

/**
 * What the workspace is for credit purposes. `payg` is a Free workspace with a card on file: it is
 * billable in Stripe but gets Free's starter credits and Free's daily brake, so most rules below
 * treat it as Free and only the on-demand one cares about the difference.
 */
export type AdminCreditPlan = "pro" | "payg" | "free";

/** The credit rules in force, read from the source-of-truth constants by the caller. */
export type CreditRuleLimits = {
  /** `FREE_STARTER_CREDITS`: the one-time grant every non-Pro workspace gets (100 today). */
  starterGrant: number;
  /** `INCLUDED_CREDITS_PER_CYCLE`: Pro's monthly included credits (500 today), no rollover. */
  includedPerCycle: number;
  /** `FREE_DAILY_CREDIT_CAP`: the Free daily brake (15 today); Pro has none. */
  freeDailyCap: number;
};

/** The three stored credit buckets, under the names the product uses rather than the schema's. */
export type AdminCreditBuckets = {
  /** `trialCreditsRemaining`: the one-time starter credits. The field name is historical. */
  starter: number;
  /** `subscriptionCreditsRemaining`: Pro's included credits for this cycle. */
  included: number;
  /** `purchasedCreditsRemaining`: credits from packs, expiring 12 months after purchase. */
  purchased: number;
};

/** Which bucket paid for a ledger row, from the four `creditsFrom*` columns. */
export type AdminCreditBucketSplit = {
  starter: number;
  subscription: number;
  purchased: number;
  onDemand: number;
};

export type AdminCreditAnomalyCode =
  | "negative_balance"
  | "starter_over_grant"
  | "on_demand_off_plan"
  | "pro_daily_brake"
  | "free_holds_included"
  | "included_over_grant"
  | "stale_pending"
  | "purchase_past_expiry";

export type AdminCreditAnomalySeverity = "high" | "medium";

export type AdminCreditAnomaly = {
  code: AdminCreditAnomalyCode;
  severity: AdminCreditAnomalySeverity;
  /** Why this row is suspicious, in one sentence, for the admin reading the list. */
  reason: string;
  /** The offending value(s), already formatted for display. */
  detail: string;
};

/** A pending ledger row older than this has outlived any real AI run. */
export const STALE_PENDING_MS = 60 * 60 * 1000;

/** Resolve the credit plan from a subscription row (or its absence). */
export function creditPlanFor(sub: SubscriptionStateLike): AdminCreditPlan {
  if (isProSubscription(sub)) return "pro";
  if (isPaygSubscription(sub)) return "payg";
  return "free";
}

/** Coerce anything a lean document or the wire might hand us into a finite number (0 otherwise). */
export function asNumber(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Credits the workspace holds. On-demand headroom is deliberately not in it: that is permission to
 * be billed, not credits owned, and `getCreditsSnapshot` draws the same line.
 */
export function totalCreditsRemaining(buckets: AdminCreditBuckets): number {
  return buckets.starter + buckets.included + buckets.purchased;
}

/**
 * Order for "closest to running out first": fewest credits held, ties broken by workspace id so
 * paging stays stable.
 *
 * There is no burn rate in the sort. A real runway (days until empty) needs a per-workspace ledger
 * aggregate, which would be one query per row of the page; credits held is the number an admin can
 * act on anyway, and the ledger panel shows what is being spent.
 */
export function compareByRunway(
  a: { totalRemaining: number; workspaceId: string },
  b: { totalRemaining: number; workspaceId: string },
): number {
  if (a.totalRemaining !== b.totalRemaining) return a.totalRemaining - b.totalRemaining;
  return a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0;
}

/** Which of a ledger row's three credit columns is the real figure for that row. */
export type CreditBasis = "charged" | "reserved" | "estimated";

/**
 * The credits number that matters for one ledger row, and which column it came from.
 *
 * A row carries an estimate, a reservation and a charge, and only one of them is true at a time: a
 * `pending` row has reserved credits and has been charged nothing, so reading the charged column
 * alone reports 0 credits for a workspace that is holding some. Both admin ledgers call this so the
 * two cannot disagree about what a pending row is worth.
 */
export function creditsShown(row: {
  status?: string | null;
  creditsCharged: number;
  creditsReserved: number;
  creditsEstimated: number;
}): { value: number; basis: CreditBasis } {
  if (row.creditsCharged > 0 || row.status === "charged") return { value: row.creditsCharged, basis: "charged" };
  if (row.creditsReserved > 0) return { value: row.creditsReserved, basis: "reserved" };
  return { value: row.creditsEstimated, basis: "estimated" };
}

/**
 * How many pages a pager may actually offer.
 *
 * `total` counts the whole collection, but the balances route sorts on a computed total that no
 * index can serve, so it refuses any page reaching past `maxWindow` rows with a 400. A pager built
 * from `total` alone therefore enables Next well past the last page that can load, and every click
 * beyond it returns an error instead of rows. Clamping here keeps the two ends agreeing.
 */
export function reachablePageCount(params: { total: number; pageSize: number; maxWindow: number }): number {
  const pageSize = Math.floor(asNumber(params.pageSize));
  if (pageSize < 1) return 1;
  const byTotal = Math.ceil(Math.max(0, asNumber(params.total)) / pageSize);
  const maxWindow = Math.floor(asNumber(params.maxWindow));
  // A maxWindow the caller never sent means "no window cap known"; fall back to the total.
  if (maxWindow <= 0) return Math.max(1, byTotal);
  return Math.max(1, Math.min(byTotal, Math.floor(maxWindow / pageSize)));
}

/** Which buckets paid for one ledger row: "subscription", "starter + purchased", or "–" for none. */
export function bucketSplitLabel(split: AdminCreditBucketSplit): string {
  const parts: string[] = [];
  if (split.subscription > 0) parts.push("subscription");
  if (split.starter > 0) parts.push("starter");
  if (split.purchased > 0) parts.push("purchased");
  if (split.onDemand > 0) parts.push("on-demand");
  // Grants, refunds and the 0-credit recipient/agent rows draw on no bucket at all.
  return parts.length ? parts.join(" + ") : "–";
}

/** Cents as a money string: "$37", "$4.50", "$0.10". */
export function fmtCents(cents: number): string {
  const dollars = asNumber(cents) / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/** Credits as written: an integer stays an integer, a fraction is shown rather than rounded away. */
export function fmtCredits(n: number): string {
  const v = asNumber(n);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/** Compact age of something, for "pending for 4h". */
export function fmtAge(ms: number): string {
  const v = Math.max(0, Math.floor(asNumber(ms)));
  const mins = Math.floor(v / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Everything that looks wrong about one workspace's stored balance.
 *
 * Each rule encodes a fact about how credits are granted today that the stored row contradicts.
 * None of them is a guess about intent: a rule fires only where the writing code could not have
 * produced the value.
 */
export function balanceAnomalies(params: {
  plan: AdminCreditPlan;
  buckets: AdminCreditBuckets;
  dailyCreditCap: number | null;
  onDemandEnabled: boolean;
  onDemandMonthlyLimitCents: number;
  limits: CreditRuleLimits;
}): AdminCreditAnomaly[] {
  const out: AdminCreditAnomaly[] = [];
  const { plan, buckets, limits } = params;
  const isPro = plan === "pro";

  // Every bucket is `min: 0` in the schema, so a negative can only have arrived through an `$inc`
  // that skipped validation — a settle or refund that deducted twice. The workspace is blocked from
  // running anything and its balance cannot be trusted until someone works out what was double-spent.
  const negatives = (["starter", "included", "purchased"] as const).filter((k) => buckets[k] < 0);
  if (negatives.length) {
    out.push({
      code: "negative_balance",
      severity: "high",
      reason: "A credit bucket is negative; the schema forbids it, so a deduction ran twice or skipped validation.",
      detail: negatives.map((k) => `${k}=${fmtCredits(buckets[k])}`).join(", "),
    });
  }

  // The starter grant lands exactly once, at `FREE_STARTER_CREDITS`, and only ever goes down from
  // there — nothing tops it up since the Free monthly floor ended 2026-09-15. A balance above the
  // grant means a second seed ran for the same workspace.
  if (buckets.starter > limits.starterGrant) {
    out.push({
      code: "starter_over_grant",
      severity: "medium",
      reason: `Starter credits are granted once at ${limits.starterGrant} and only decrease, so a higher balance means a second grant.`,
      detail: `starter=${fmtCredits(buckets.starter)} > ${limits.starterGrant}`,
    });
  }

  // On-demand is Pro-only: `getCreditsSnapshot` forces `onDemandEnabled=false` and the limit to 0
  // off Pro whatever is stored. A non-Pro row with the toggle on is dead config, usually left by a
  // downgrade, and it makes the workspace look metered in Mongo while nothing can ever bill.
  if (!isPro && (params.onDemandEnabled || params.onDemandMonthlyLimitCents > 0)) {
    out.push({
      code: "on_demand_off_plan",
      severity: "medium",
      reason: "On-demand is Pro-only; a non-Pro workspace with it enabled is stale config the snapshot silently ignores.",
      detail: `plan=${plan}, onDemandEnabled=${params.onDemandEnabled}, limit=${fmtCents(params.onDemandMonthlyLimitCents)}`,
    });
  }

  // `grantCycleIncludedCredits` clears the daily brake when it opens a Pro cycle. A Pro workspace
  // still carrying a cap means that grant never ran (typically a missed Stripe webhook), so a paying
  // customer is being throttled at the Free rate.
  if (isPro && params.dailyCreditCap !== null) {
    out.push({
      code: "pro_daily_brake",
      severity: "high",
      reason: "Pro has no daily cap; a stored cap means the cycle grant never ran and the workspace is throttled at the Free rate.",
      detail: `dailyCreditCap=${fmtCredits(params.dailyCreditCap)} (Free is ${limits.freeDailyCap})`,
    });
  }

  // The included bucket is filled only by the Pro cycle grant. On a non-Pro workspace it is credit
  // left behind by a cancellation, and it is spent first (`allocateBuckets` drains subscription
  // before starter), so the workspace is running on credits it no longer pays for.
  if (!isPro && buckets.included > 0) {
    out.push({
      code: "free_holds_included",
      severity: "medium",
      reason: "Only the Pro cycle grant fills the included bucket; a non-Pro workspace holding some is a leftover from a cancelled subscription.",
      detail: `plan=${plan}, included=${fmtCredits(buckets.included)}`,
    });
  }

  // The cycle grant sets the included bucket to exactly `INCLUDED_CREDITS_PER_CYCLE` (no rollover)
  // and spending only lowers it. Above that, something added credits on top of the cycle reset — an
  // admin grant, or a grant applied to a balance it did not reset.
  if (buckets.included > limits.includedPerCycle) {
    out.push({
      code: "included_over_grant",
      severity: "medium",
      reason: `The cycle grant sets included credits to ${limits.includedPerCycle} with no rollover, so a larger balance was added on top of it.`,
      detail: `included=${fmtCredits(buckets.included)} > ${limits.includedPerCycle}`,
    });
  }

  return out;
}

/**
 * A reservation that was never settled.
 *
 * `reserveCreditsOrThrow` writes a `pending` row and the settle step flips it to charged, refunded
 * or failed within one AI run. Still pending an hour later means the run died between the two, and
 * the reserved credits are held against a workspace that can no longer spend them.
 */
export function isStalePending(params: { status: string; createdAtMs: number; nowMs: number }): boolean {
  if (params.status !== "pending") return false;
  const age = params.nowMs - params.createdAtMs;
  return Number.isFinite(age) && age > STALE_PENDING_MS;
}

/**
 * A purchase whose credits should already have been taken back.
 *
 * `expireCreditPurchases` runs daily and stamps `expiredAt` once it has reclaimed a pack's unspent
 * credits. A row past `expiresAt` with `expiredAt` still null means that job has not reached it, so
 * the workspace is still spending credits it stopped owning.
 *
 * A live pack on a Pro workspace is deliberately NOT an anomaly: packs are Free-only at purchase
 * time (`/api/credits/purchase` returns 409 on Pro), but a workspace that bought one and then
 * upgraded keeps it, which is exactly what the balance shows.
 */
export function isPurchasePastExpiry(params: {
  expiresAtMs: number | null;
  expiredAtMs: number | null;
  nowMs: number;
}): boolean {
  if (params.expiredAtMs !== null) return false;
  if (params.expiresAtMs === null) return false;
  return params.expiresAtMs <= params.nowMs;
}
