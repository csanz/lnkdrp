import { describe, expect, test } from "vitest";

import { getInvoiceSubscriptionId, getSubscriptionPeriod, parseStripeUnixSeconds } from "@/lib/billing/stripePeriods";

describe("billing/stripePeriods", () => {
  test("reads the period from subscription items first (API 2025-12-15+)", () => {
    const sub = {
      current_period_start: 1,
      current_period_end: 2,
      items: { data: [{ current_period_start: 1_700_000_000, current_period_end: 1_702_592_000 }] },
    };
    const { start, end } = getSubscriptionPeriod(sub);
    expect(start?.getTime()).toBe(1_700_000_000_000);
    expect(end?.getTime()).toBe(1_702_592_000_000);
  });

  test("falls back to top-level fields for legacy payloads", () => {
    const { start, end } = getSubscriptionPeriod({ current_period_start: "1700000000", current_period_end: 1_702_592_000, items: { data: [] } });
    expect(start?.getTime()).toBe(1_700_000_000_000);
    expect(end?.getTime()).toBe(1_702_592_000_000);
    expect(getSubscriptionPeriod(null)).toEqual({ start: null, end: null });
    expect(getSubscriptionPeriod({})).toEqual({ start: null, end: null });
  });

  test("reads invoice subscription id from parent.subscription_details first, then legacy field", () => {
    expect(getInvoiceSubscriptionId({ parent: { subscription_details: { subscription: "sub_new" } }, subscription: "sub_old" })).toBe("sub_new");
    expect(getInvoiceSubscriptionId({ parent: { subscription_details: { subscription: { id: "sub_obj" } } } })).toBe("sub_obj");
    expect(getInvoiceSubscriptionId({ parent: null, subscription: "sub_old" })).toBe("sub_old");
    expect(getInvoiceSubscriptionId({ parent: { type: "quote_details" } })).toBe("");
    expect(getInvoiceSubscriptionId(null)).toBe("");
  });

  test("parseStripeUnixSeconds tolerates numbers, bigints and numeric strings", () => {
    expect(parseStripeUnixSeconds(10)?.getTime()).toBe(10_000);
    expect(parseStripeUnixSeconds(BigInt(10))?.getTime()).toBe(10_000);
    expect(parseStripeUnixSeconds(" 10 ")?.getTime()).toBe(10_000);
    expect(parseStripeUnixSeconds("nope")).toBeNull();
    expect(parseStripeUnixSeconds(undefined)).toBeNull();
  });
});
