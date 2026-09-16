import { describe, expect, test } from "vitest";

import {
  isBillableStatus,
  isBillableSubscription,
  isPaygSubscription,
  isProSubscription,
  subscriptionKind,
  subscriptionKindFromPriceIds,
  PRO_KIND_FILTER,
} from "@/lib/billing/subscriptionState";

/**
 * Pay-as-you-go broke the equation "active subscription = Pro": a Free workspace that adds a
 * card to buy on-demand credits gets a subscription too, `active` in Stripe, holding only the
 * metered credits price. These pin the two questions everything else in billing now has to ask
 * separately, and the one rule that must never regress: a legacy row with no `kind` at all
 * (every row written before pay-as-you-go existed) reads as Pro, never as neither.
 */
describe("isBillableStatus", () => {
  test("active and trialing are billable", () => {
    expect(isBillableStatus("active")).toBe(true);
    expect(isBillableStatus("trialing")).toBe(true);
  });

  test("everything else, including missing, is not", () => {
    for (const s of ["past_due", "canceled", "unpaid", "incomplete", "", null, undefined, 42]) {
      expect(isBillableStatus(s)).toBe(false);
    }
  });

  test("case and whitespace tolerant", () => {
    expect(isBillableStatus(" Active ")).toBe(true);
    expect(isBillableStatus("TRIALING")).toBe(true);
  });
});

describe("subscriptionKind", () => {
  test("payg only when the row says so", () => {
    expect(subscriptionKind({ kind: "payg" })).toBe("payg");
  });

  test("everything else, including a legacy row with no kind at all, is pro", () => {
    expect(subscriptionKind({ kind: "pro" })).toBe("pro");
    expect(subscriptionKind({})).toBe("pro");
    expect(subscriptionKind(null)).toBe("pro");
    expect(subscriptionKind(undefined)).toBe("pro");
    expect(subscriptionKind({ kind: "something-unexpected" })).toBe("pro");
  });
});

describe("isProSubscription", () => {
  test("billable and pro", () => {
    expect(isProSubscription({ status: "active", kind: "pro" })).toBe(true);
    expect(isProSubscription({ status: "trialing" })).toBe(true); // legacy row, no kind
  });

  test("billable but payg is not pro", () => {
    expect(isProSubscription({ status: "active", kind: "payg" })).toBe(false);
  });

  test("pro price but not billable is not pro", () => {
    expect(isProSubscription({ status: "past_due", kind: "pro" })).toBe(false);
    expect(isProSubscription({ status: "canceled", kind: "pro" })).toBe(false);
  });

  test("no row at all is not pro", () => {
    expect(isProSubscription(null)).toBe(false);
    expect(isProSubscription(undefined)).toBe(false);
  });
});

describe("isPaygSubscription", () => {
  test("billable and payg", () => {
    expect(isPaygSubscription({ status: "active", kind: "payg" })).toBe(true);
  });

  test("billable pro is not payg", () => {
    expect(isPaygSubscription({ status: "active", kind: "pro" })).toBe(false);
    expect(isPaygSubscription({ status: "active" })).toBe(false); // legacy
  });

  test("payg kind but not billable is not payg", () => {
    expect(isPaygSubscription({ status: "canceled", kind: "payg" })).toBe(false);
  });
});

describe("isBillableSubscription", () => {
  test("true for either kind, as long as the status is billable", () => {
    expect(isBillableSubscription({ status: "active", kind: "pro" })).toBe(true);
    expect(isBillableSubscription({ status: "trialing", kind: "payg" })).toBe(true);
  });

  test("false when not billable, regardless of kind", () => {
    expect(isBillableSubscription({ status: "past_due", kind: "pro" })).toBe(false);
    expect(isBillableSubscription({ status: "past_due", kind: "payg" })).toBe(false);
  });

  test("every pro row is also billable (isProSubscription implies isBillableSubscription)", () => {
    const rows = [
      { status: "active", kind: "pro" },
      { status: "trialing" },
      { status: "active", kind: "payg" },
      { status: "past_due", kind: "pro" },
      null,
    ];
    for (const r of rows) {
      if (isProSubscription(r)) expect(isBillableSubscription(r)).toBe(true);
    }
  });

  test("pro and payg are mutually exclusive for any row", () => {
    const rows = [
      { status: "active", kind: "pro" },
      { status: "active", kind: "payg" },
      { status: "active" },
      { status: "past_due", kind: "payg" },
      null,
      undefined,
    ];
    for (const r of rows) {
      expect(isProSubscription(r) && isPaygSubscription(r)).toBe(false);
    }
  });
});

describe("PRO_KIND_FILTER", () => {
  test("shape excludes payg and admits everything else, including absent kind", () => {
    expect(PRO_KIND_FILTER).toEqual({ kind: { $ne: "payg" } });
  });
});

describe("subscriptionKindFromPriceIds", () => {
  const proPriceId = "price_pro_123";
  const creditsPriceId = "price_credits_456";

  test("Pro price present, whatever else rides along, is pro", () => {
    expect(subscriptionKindFromPriceIds({ priceIds: [proPriceId], proPriceId, creditsPriceId })).toBe("pro");
    expect(subscriptionKindFromPriceIds({ priceIds: [proPriceId, creditsPriceId], proPriceId, creditsPriceId })).toBe("pro");
  });

  test("credits price alone, no Pro price, is payg", () => {
    expect(subscriptionKindFromPriceIds({ priceIds: [creditsPriceId], proPriceId, creditsPriceId })).toBe("payg");
  });

  test("neither known price is unresolved (caller keeps the stored value)", () => {
    expect(subscriptionKindFromPriceIds({ priceIds: ["price_unknown"], proPriceId, creditsPriceId })).toBeNull();
    expect(subscriptionKindFromPriceIds({ priceIds: [], proPriceId, creditsPriceId })).toBeNull();
  });

  test("tolerates missing configured price ids without throwing", () => {
    expect(subscriptionKindFromPriceIds({ priceIds: [creditsPriceId], proPriceId: null, creditsPriceId })).toBe("payg");
    expect(subscriptionKindFromPriceIds({ priceIds: [proPriceId], proPriceId, creditsPriceId: undefined })).toBe("pro");
    expect(subscriptionKindFromPriceIds({ priceIds: [], proPriceId: null, creditsPriceId: null })).toBeNull();
  });

  test("blank configured ids never match a blank/whitespace item id", () => {
    expect(subscriptionKindFromPriceIds({ priceIds: [""], proPriceId: "", creditsPriceId: "" })).toBeNull();
  });
});
