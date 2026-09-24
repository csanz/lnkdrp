/**
 * Annual Pro: twelve months for the price of ten, and the two rules that follow from Stripe
 * refusing to put the monthly metered credits price on a yearly subscription.
 *
 * - No on-demand on yearly: `onDemandEligible` is monthly Pro only.
 * - Packs on yearly: `creditPacksAllowed` is Free or annual Pro, never monthly Pro.
 * - The webhook must read the yearly price as Pro and the licensed item's interval as the plan's,
 *   ignoring the metered item (always monthly) when there is one.
 *
 * The checkout route's contract is checked from its source, the way `waitlistPaymentGate` does:
 * the metered price is only added on a monthly Checkout, and asking for yearly without the price
 * configured is refused rather than silently billed monthly.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  creditPacksAllowed,
  isAnnualProSubscription,
  onDemandEligible,
  subscriptionInterval,
  subscriptionIntervalFromItems,
  subscriptionKindFromPriceIds,
} from "@/lib/billing/subscriptionState";

const MONTHLY = "price_month";
const ANNUAL = "price_year";
const CREDITS = "price_credits";

describe("subscriptionInterval", () => {
  test("yearly only when the row says so; legacy rows are monthly", () => {
    expect(subscriptionInterval({ status: "active", interval: "year" })).toBe("year");
    expect(subscriptionInterval({ status: "active", interval: "month" })).toBe("month");
    expect(subscriptionInterval({ status: "active" })).toBe("month");
    expect(subscriptionInterval(null)).toBe("month");
  });
});

describe("on-demand and packs, by plan", () => {
  const free = { status: "free" };
  const monthlyPro = { status: "active", kind: "pro", interval: "month" };
  const legacyPro = { status: "active" };
  const annualPro = { status: "active", kind: "pro", interval: "year" };
  const lapsedAnnual = { status: "past_due", kind: "pro", interval: "year" };
  const payg = { status: "active", kind: "payg" };

  test("on-demand is monthly Pro only", () => {
    expect(onDemandEligible(monthlyPro)).toBe(true);
    expect(onDemandEligible(legacyPro)).toBe(true);
    expect(onDemandEligible(annualPro)).toBe(false);
    expect(onDemandEligible(lapsedAnnual)).toBe(false);
    expect(onDemandEligible(free)).toBe(false);
    expect(onDemandEligible(payg)).toBe(false);
  });

  test("packs are for Free and annual Pro, never monthly Pro", () => {
    expect(creditPacksAllowed(free)).toBe(true);
    expect(creditPacksAllowed(payg)).toBe(true);
    expect(creditPacksAllowed(annualPro)).toBe(true);
    expect(creditPacksAllowed(monthlyPro)).toBe(false);
    expect(creditPacksAllowed(legacyPro)).toBe(false);
    // A lapsed annual Pro is not Pro, so it is back on the Free rule.
    expect(creditPacksAllowed(lapsedAnnual)).toBe(true);
  });

  test("isAnnualProSubscription needs billable + Pro + yearly", () => {
    expect(isAnnualProSubscription(annualPro)).toBe(true);
    expect(isAnnualProSubscription({ ...annualPro, status: "trialing" })).toBe(true);
    expect(isAnnualProSubscription(lapsedAnnual)).toBe(false);
    expect(isAnnualProSubscription(monthlyPro)).toBe(false);
  });
});

describe("what the webhook derives from Stripe items", () => {
  test("the yearly price is Pro, and the metered price alone is still payg", () => {
    const ids = { proPriceId: MONTHLY, proAnnualPriceId: ANNUAL, creditsPriceId: CREDITS };
    expect(subscriptionKindFromPriceIds({ ...ids, priceIds: [ANNUAL] })).toBe("pro");
    expect(subscriptionKindFromPriceIds({ ...ids, priceIds: [MONTHLY, CREDITS] })).toBe("pro");
    expect(subscriptionKindFromPriceIds({ ...ids, priceIds: [CREDITS] })).toBe("payg");
    expect(subscriptionKindFromPriceIds({ ...ids, priceIds: ["price_other"] })).toBeNull();
    // A deployment without the annual price is unchanged.
    expect(subscriptionKindFromPriceIds({ proPriceId: MONTHLY, creditsPriceId: CREDITS, priceIds: [ANNUAL] })).toBeNull();
  });

  test("the interval comes from the licensed item, never the metered one", () => {
    const licensedYear = { price: { recurring: { interval: "year", usage_type: "licensed" } } };
    const licensedMonth = { price: { recurring: { interval: "month", usage_type: "licensed" } } };
    const metered = { price: { recurring: { interval: "month", usage_type: "metered" } } };
    expect(subscriptionIntervalFromItems([licensedYear])).toBe("year");
    expect(subscriptionIntervalFromItems([metered, licensedMonth])).toBe("month");
    expect(subscriptionIntervalFromItems([metered])).toBeNull();
    expect(subscriptionIntervalFromItems([])).toBeNull();
    expect(subscriptionIntervalFromItems([null, { price: null }])).toBeNull();
  });
});

describe("the checkout route", () => {
  const src = readFileSync(join(__dirname, "../../src/app/api/stripe/checkout/route.ts"), "utf8");

  test("adds the metered credits price only on a monthly Checkout", () => {
    expect(src).toContain('aiCreditsPriceId && interval === "month"');
  });

  test("refuses yearly when the annual price is not configured, rather than billing monthly", () => {
    expect(src).toContain('code: "ANNUAL_NOT_CONFIGURED"');
    expect(src).toContain('interval === "year" && !annualPriceId');
  });

  test("tells the webhook which interval it sold", () => {
    expect(src).toContain("subscription_data: { metadata: { userId: String(userId), orgId: String(orgId), kind: plan, interval } }");
  });
});
