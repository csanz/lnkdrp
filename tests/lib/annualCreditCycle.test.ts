/**
 * An annual subscriber has to get 500 credits a month, not 500 a year.
 *
 * The included-credits grant is idempotent per `cycleKey`, and the key was
 * `${subscriptionId}:${currentPeriodStartUnixSeconds}` — derived from Stripe's *current period*.
 * On a monthly plan that is one key a month, which is correct and is why nobody noticed. On a
 * yearly plan Stripe's current period is a year: one period, one key, one grant. Selling an annual
 * plan against that code would have given a customer who paid for twelve months of credits a
 * twelfth of them, and the admin anomaly report would have called the workspace healthy.
 *
 * The fix is a `:m<N>` suffix for periods longer than a month. `m0` is deliberately not written, so
 * every key that exists today keeps its exact shape and no monthly subscriber is re-granted.
 */
import { describe, expect, test } from "vitest";

import { buildCycleKey, creditMonthIndex, creditWindowIndex } from "@/lib/credits/grants";

const d = (iso: string) => new Date(iso);
const SUB = "sub_123";

describe("a monthly subscription is untouched", () => {
  test("its key has no suffix, exactly as before", () => {
    const start = d("2026-09-01T00:00:00Z");
    const end = d("2026-10-01T00:00:00Z");

    expect(creditWindowIndex(start, end, d("2026-09-20T00:00:00Z"))).toBe(0);
    expect(buildCycleKey({ stripeSubscriptionId: SUB, currentPeriodStart: start })).toBe(`${SUB}:${start.getTime() / 1000}`);
    expect(buildCycleKey({ stripeSubscriptionId: SUB, currentPeriodStart: start, monthIndex: 0 })).toBe(
      `${SUB}:${start.getTime() / 1000}`,
    );
  });

  test("a missing period end is treated as monthly rather than guessed", () => {
    expect(creditWindowIndex(d("2026-09-01T00:00:00Z"), null, d("2027-03-01T00:00:00Z"))).toBe(0);
  });
});

describe("an annual subscription is split into twelve windows", () => {
  const start = d("2026-09-01T00:00:00Z");
  const end = d("2027-09-01T00:00:00Z");

  test("the window advances once a month", () => {
    expect(creditWindowIndex(start, end, d("2026-09-01T00:00:00Z"))).toBe(0);
    expect(creditWindowIndex(start, end, d("2026-09-30T00:00:00Z"))).toBe(0);
    expect(creditWindowIndex(start, end, d("2026-10-01T00:00:00Z"))).toBe(1);
    expect(creditWindowIndex(start, end, d("2027-08-01T00:00:00Z"))).toBe(11);
  });

  test("twelve months produce twelve distinct keys", () => {
    const keys = new Set<string>();
    for (let m = 0; m < 12; m++) {
      const now = new Date(Date.UTC(2026, 8 + m, 15));
      keys.add(buildCycleKey({ stripeSubscriptionId: SUB, currentPeriodStart: start, monthIndex: creditWindowIndex(start, end, now) }));
    }
    expect(keys.size, "one grant per month of the year").toBe(12);
  });

  test("the first window shares the unsuffixed key, so nothing is re-granted", () => {
    expect(buildCycleKey({ stripeSubscriptionId: SUB, currentPeriodStart: start, monthIndex: 0 })).not.toContain(":m");
  });
});

describe("month counting", () => {
  test("a period starting on the 31st does not advance on the 1st", () => {
    // Without the day-of-month check, Jan 31 -> Feb 1 reads as a new month after one day.
    const start = d("2027-01-31T00:00:00Z");
    expect(creditMonthIndex(start, d("2027-02-01T00:00:00Z"))).toBe(0);
    expect(creditMonthIndex(start, d("2027-02-28T00:00:00Z"))).toBe(0);
    expect(creditMonthIndex(start, d("2027-03-31T00:00:00Z"))).toBe(2);
  });

  test("a time before the period start is window 0, never negative", () => {
    expect(creditMonthIndex(d("2026-09-01T00:00:00Z"), d("2026-08-01T00:00:00Z"))).toBe(0);
  });
});
