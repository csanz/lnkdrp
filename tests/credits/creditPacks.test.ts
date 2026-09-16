import { describe, expect, test } from "vitest";
import {
  CREDIT_PACKS,
  findCreditPack,
  formatPackPrice,
  formatPerCredit,
  planPurchaseExpiry,
  purchaseExpiresAt,
  type PurchaseLot,
} from "@/lib/credits/packs";

const PRO_CENTS_PER_CREDIT = 2900 / 300;
const d = (iso: string) => new Date(iso);
const lot = (id: string, credits: number, bought: string, expires: string): PurchaseLot => ({
  id,
  credits,
  purchasedAt: d(bought),
  expiresAt: d(expires),
});

describe("credit pack catalog", () => {
  test("30/$5, 60/$9, 300/$39", () => {
    expect(CREDIT_PACKS.map((p) => [p.credits, p.priceCents])).toEqual([
      [30, 500],
      [60, 900],
      [300, 3900],
    ]);
  });

  test("every pack costs more per credit than Pro, so the page can point at Pro honestly", () => {
    for (const p of CREDIT_PACKS) expect(p.priceCents / p.credits).toBeGreaterThan(PRO_CENTS_PER_CREDIT);
  });

  test("only known pack ids resolve", () => {
    expect(findCreditPack("credits_60")?.credits).toBe(60);
    expect(findCreditPack("credits_1000")).toBeNull();
    expect(findCreditPack(undefined)).toBeNull();
  });

  test("labels", () => {
    expect(formatPackPrice(500)).toBe("$5");
    expect(formatPackPrice(450)).toBe("$4.50");
    expect(formatPerCredit(CREDIT_PACKS[0])).toBe("$0.17");
    expect(formatPerCredit(CREDIT_PACKS[2])).toBe("$0.13");
  });

  test("expires 12 calendar months after purchase", () => {
    expect(purchaseExpiresAt(d("2026-09-16T10:00:00Z")).toISOString()).toBe("2027-09-16T10:00:00.000Z");
  });
});

describe("planPurchaseExpiry (oldest purchase is spent first)", () => {
  const now = d("2027-09-17T00:00:00Z");

  test("nothing due: nothing expires", () => {
    const r = planPurchaseExpiry({ remaining: 30, lots: [lot("a", 30, "2027-01-01", "2028-01-01")], now });
    expect(r).toEqual({ expire: [], remainingAfter: 30 });
  });

  test("an untouched due purchase takes all of its credits", () => {
    const r = planPurchaseExpiry({ remaining: 30, lots: [lot("a", 30, "2026-09-16", "2027-09-16")], now });
    expect(r).toEqual({ expire: [{ id: "a", credits: 30 }], remainingAfter: 0 });
  });

  test("a partly spent due purchase takes only what is left of it", () => {
    const r = planPurchaseExpiry({ remaining: 12, lots: [lot("a", 30, "2026-09-16", "2027-09-16")], now });
    expect(r).toEqual({ expire: [{ id: "a", credits: 12 }], remainingAfter: 0 });
  });

  test("a newer live purchase keeps its credits; the old one is treated as spent first", () => {
    // Bought 30, then 60; 50 left. Oldest-first means the 30 is gone and 50 of the 60 remain.
    const r = planPurchaseExpiry({
      remaining: 50,
      lots: [lot("old", 30, "2026-09-16", "2027-09-16"), lot("new", 60, "2027-03-01", "2028-03-01")],
      now,
    });
    expect(r).toEqual({ expire: [{ id: "old", credits: 0 }], remainingAfter: 50 });
  });

  test("old purchase partly left while a newer one is untouched", () => {
    const r = planPurchaseExpiry({
      remaining: 70,
      lots: [lot("new", 60, "2027-03-01", "2028-03-01"), lot("old", 30, "2026-09-16", "2027-09-16")],
      now,
    });
    expect(r).toEqual({ expire: [{ id: "old", credits: 10 }], remainingAfter: 60 });
  });

  test("two due purchases expire oldest first", () => {
    const r = planPurchaseExpiry({
      remaining: 80,
      lots: [lot("a", 30, "2026-09-01", "2027-09-01"), lot("b", 60, "2026-09-10", "2027-09-10")],
      now,
    });
    expect(r).toEqual({
      expire: [
        { id: "a", credits: 20 },
        { id: "b", credits: 60 },
      ],
      remainingAfter: 0,
    });
  });

  test("never removes more than a purchase added, even when refunds pushed the counter higher", () => {
    const r = planPurchaseExpiry({ remaining: 45, lots: [lot("a", 30, "2026-09-16", "2027-09-16")], now });
    expect(r).toEqual({ expire: [{ id: "a", credits: 30 }], remainingAfter: 15 });
  });
});
