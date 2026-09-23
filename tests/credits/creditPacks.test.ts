/**
 * What a prepaid credit costs, and why the old guard here did not catch it being wrong.
 *
 * The rule is one sentence: a pack credit costs about 60% more than a Pro credit, so buying packs
 * often feels worse than subscribing. The packs broke it badly — 13c to 16.7c a credit against
 * Pro's 5.8c, which is 2.2x to 2.9x, and dearer even than the 10c pay-as-you-go rate, so prepaying
 * was a *penalty*.
 *
 * This file is why it survived. The guard below asserted only "dearer than Pro", against a
 * `PRO_CENTS_PER_CREDIT` of `2900 / 300` — the 300-credit allowance from before Pro moved to 500.
 * A wrong baseline and a one-sided comparison agreed with each other. Now the rate comes from the
 * same constants the pricing does, and the assertion is a band: too cheap cannibalises Pro, too
 * dear is the bug that was here.
 */
import { describe, expect, test } from "vitest";
import {
  CREDIT_PACKS,
  PACK_MARKUP_OVER_PRO,
  PRO_CENTS_PER_CREDIT,
  RETIRED_CREDIT_PACKS,
  findCreditPack,
  findPurchasablePack,
  formatPackPrice,
  formatPerCredit,
  planPurchaseExpiry,
  purchaseExpiresAt,
  type PurchaseLot,
} from "@/lib/credits/packs";

/** The on-demand rate (`USD_CENTS_PER_CREDIT`), which a prepaid pack must never exceed. */
const ON_DEMAND_CENTS_PER_CREDIT = 10;
const d = (iso: string) => new Date(iso);
const lot = (id: string, credits: number, bought: string, expires: string): PurchaseLot => ({
  id,
  credits,
  purchasedAt: d(bought),
  expiresAt: d(expires),
});

describe("credit pack catalog", () => {
  test("75/$7, 150/$14, 400/$37", () => {
    expect(CREDIT_PACKS.map((p) => [p.credits, p.priceCents])).toEqual([
      [75, 700],
      [150, 1400],
      [400, 3700],
    ]);
  });

  test("Pro's rate is read from Pro's real allowance, not a remembered one", () => {
    // The whole bug: this was 2900/300 = 9.67c while Pro had been 500 credits for a week.
    expect(PRO_CENTS_PER_CREDIT).toBeCloseTo(5.8, 5);
  });

  test("every pack sits near the markup, not merely above Pro", () => {
    // A one-sided "dearer than Pro" is what let 2.9x through. Both sides, +/- 5 points.
    for (const p of CREDIT_PACKS) {
      const multiple = p.priceCents / p.credits / PRO_CENTS_PER_CREDIT;
      expect(multiple, `${p.id} vs Pro`).toBeGreaterThan(PACK_MARKUP_OVER_PRO - 0.05);
      expect(multiple, `${p.id} vs Pro`).toBeLessThan(PACK_MARKUP_OVER_PRO + 0.05);
    }
  });

  test("prepaying is never dearer than paying as you go", () => {
    // Committing cash up front has to buy something. It used to cost 30-67% more.
    for (const p of CREDIT_PACKS) {
      expect(p.priceCents / p.credits, `${p.id} vs on-demand`).toBeLessThan(ON_DEMAND_CENTS_PER_CREDIT);
    }
  });

  test("a bigger pack is never worse value than a smaller one", () => {
    const rates = CREDIT_PACKS.map((p) => p.priceCents / p.credits);
    for (let i = 1; i < rates.length; i++) expect(rates[i]).toBeLessThanOrEqual(rates[i - 1]);
  });

  test("only known pack ids resolve", () => {
    expect(findCreditPack("credits_150")?.credits).toBe(150);
    expect(findCreditPack("credits_1000")).toBeNull();
    expect(findCreditPack(undefined)).toBeNull();
  });

  test("a retired id still records, but cannot be sold", () => {
    // `recordPurchase` throws on an unknown id and runs in the webhook, after the customer paid:
    // a Checkout opened before a repricing deploy still carries its old packId.
    expect(findCreditPack("credits_30")?.priceCents).toBe(500);
    expect(findPurchasablePack("credits_30")).toBeNull();
    expect(findPurchasablePack("credits_150")?.credits).toBe(150);
  });

  test("no retired id is ever reused by a pack on sale", () => {
    const onSale = new Set(CREDIT_PACKS.map((p) => p.id));
    for (const r of RETIRED_CREDIT_PACKS) expect(onSale.has(r.id), `${r.id} reused`).toBe(false);
  });

  test("labels", () => {
    expect(formatPackPrice(500)).toBe("$5");
    expect(formatPackPrice(450)).toBe("$4.50");
    expect(formatPerCredit(CREDIT_PACKS[0])).toBe("$0.09");
    expect(formatPerCredit(CREDIT_PACKS[2])).toBe("$0.09");
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
