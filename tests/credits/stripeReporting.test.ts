import { afterEach, describe, expect, test, vi } from "vitest";

import {
  batchIdempotencyKey,
  buildMeterEventParams,
  DEFAULT_CREDITS_METER_EVENT_NAME,
  getAiCreditsPriceId,
  getCreditsMeterEventName,
  groupClaimedLedgersByBatch,
  groupOnDemandLedgersForStripe,
  REPORT_CLAIM_TTL_MS,
} from "@/lib/credits/stripeReporting";

describe("credits/stripeReporting", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("groups only on-demand credits by Stripe customer and ignores zeros", () => {
    const map = new Map<string, string>([
      ["w1", "cus_1"],
      ["w2", "cus_1"],
      ["w3", "cus_2"],
    ]);
    const grouped = groupOnDemandLedgersForStripe({
      stripeCustomerIdByWorkspaceId: map,
      ledgers: [
        { id: "a", workspaceId: "w1", creditsFromOnDemand: 3 },
        { id: "b", workspaceId: "w1", creditsFromOnDemand: 0 },
        { id: "c", workspaceId: "w2", creditsFromOnDemand: 2 },
        { id: "d", workspaceId: "w3", creditsFromOnDemand: 5 },
        { id: "e", workspaceId: "w_missing", creditsFromOnDemand: 10 },
      ],
    });

    expect(grouped.get("cus_1")?.quantity).toBe(5);
    expect(grouped.get("cus_1")?.ledgerIds.sort()).toEqual(["a", "c"]);
    expect(grouped.get("cus_2")?.quantity).toBe(5);
    expect(grouped.get("cus_2")?.ledgerIds).toEqual(["d"]);
    expect(grouped.has("w_missing")).toBe(false);
  });

  test("batch idempotency key is order-independent and customer-scoped", () => {
    const a = batchIdempotencyKey({ stripeCustomerId: "cus_1", ledgerIds: ["c", "a", "b"] });
    const b = batchIdempotencyKey({ stripeCustomerId: "cus_1", ledgerIds: ["b", "c", "a"] });
    const c = batchIdempotencyKey({ stripeCustomerId: "cus_2", ledgerIds: ["b", "c", "a"] });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith("credits-report:")).toBe(true);
  });

  test("builds meter event params with a string value and the batch id as identifier", () => {
    const params = buildMeterEventParams({
      eventName: "ai_credits",
      stripeCustomerId: "cus_1",
      credits: 7.9,
      identifier: "credits-report:abc",
      timestampUnixSeconds: 1_700_000_000,
    });
    expect(params).toEqual({
      event_name: "ai_credits",
      payload: { stripe_customer_id: "cus_1", value: "7" },
      identifier: "credits-report:abc",
      timestamp: 1_700_000_000,
    });
    expect(buildMeterEventParams({ eventName: "x", stripeCustomerId: "cus_1", credits: -1, identifier: "i" }).payload.value).toBe("0");
  });

  test("meter event name defaults to ai_credits and honours STRIPE_CREDITS_METER_EVENT_NAME", () => {
    vi.stubEnv("STRIPE_CREDITS_METER_EVENT_NAME", "");
    expect(getCreditsMeterEventName()).toBe(DEFAULT_CREDITS_METER_EVENT_NAME);
    vi.stubEnv("STRIPE_CREDITS_METER_EVENT_NAME", " lnkdrp_credits ");
    expect(getCreditsMeterEventName()).toBe("lnkdrp_credits");
  });

  test("getAiCreditsPriceId prefers STRIPE_AI_CREDITS_PRICE_ID, falls back to STRIPE_USAGE_PRICE_ID, else null", () => {
    vi.stubEnv("STRIPE_AI_CREDITS_PRICE_ID", "");
    vi.stubEnv("STRIPE_USAGE_PRICE_ID", "");
    expect(getAiCreditsPriceId()).toBeNull();

    vi.stubEnv("STRIPE_USAGE_PRICE_ID", "price_legacy");
    expect(getAiCreditsPriceId()).toBe("price_legacy");

    vi.stubEnv("STRIPE_AI_CREDITS_PRICE_ID", " price_canonical ");
    expect(getAiCreditsPriceId()).toBe("price_canonical");
  });

  test("groups stale-claimed rows by their stored batch id (never re-batched), skipping unmapped workspaces", () => {
    const map = new Map<string, string>([
      ["w1", "cus_1"],
      ["w2", "cus_2"],
    ]);
    const grouped = groupClaimedLedgersByBatch({
      stripeCustomerIdByWorkspaceId: map,
      ledgers: [
        { id: "a", workspaceId: "w1", creditsFromOnDemand: 3, reportBatchId: "credits-report:b1" },
        { id: "b", workspaceId: "w1", creditsFromOnDemand: 4, reportBatchId: "credits-report:b1" },
        { id: "c", workspaceId: "w2", creditsFromOnDemand: 2, reportBatchId: "credits-report:b2" },
        // No customer mapping any more: must be left alone (not merged into another batch).
        { id: "d", workspaceId: "w_gone", creditsFromOnDemand: 9, reportBatchId: "credits-report:b3" },
        // Inconsistent row (batch b1 belongs to cus_1): ignored defensively.
        { id: "e", workspaceId: "w2", creditsFromOnDemand: 1, reportBatchId: "credits-report:b1" },
      ],
    });

    expect([...grouped.keys()].sort()).toEqual(["credits-report:b1", "credits-report:b2"]);
    expect(grouped.get("credits-report:b1")).toEqual({ stripeCustomerId: "cus_1", ledgerIds: ["a", "b"], quantity: 7 });
    expect(grouped.get("credits-report:b2")).toEqual({ stripeCustomerId: "cus_2", ledgerIds: ["c"], quantity: 2 });
    // The batch id doubles as the Stripe identifier, so a replay reuses exactly the original key.
    expect(batchIdempotencyKey({ stripeCustomerId: "cus_1", ledgerIds: ["b", "a"] })).toBe(
      batchIdempotencyKey({ stripeCustomerId: "cus_1", ledgerIds: ["a", "b"] }),
    );
  });

  test("claim TTL is 30 minutes", () => {
    expect(REPORT_CLAIM_TTL_MS).toBe(30 * 60 * 1000);
  });
});
