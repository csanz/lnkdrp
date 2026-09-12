import { describe, expect, test } from "vitest";

import { FREE_STARTER_CREDITS, INCLUDED_CREDITS_PER_CYCLE, buildCycleKey } from "@/lib/credits/grants";

describe("credits/grants", () => {
  test("cycleKey uses unix seconds (stable, UTC)", () => {
    const d = new Date(Date.UTC(2026, 0, 4, 12, 34, 56)); // 2026-01-04T12:34:56.000Z
    const key = buildCycleKey({ stripeSubscriptionId: "sub_123", currentPeriodStart: d });
    expect(key).toBe(`sub_123:${Math.floor(d.getTime() / 1000)}`);
  });

  test("Free gets a one-time 50-credit starter grant, Pro gets 300 per cycle", () => {
    expect(FREE_STARTER_CREDITS).toBe(50);
    expect(INCLUDED_CREDITS_PER_CYCLE).toBe(300);
  });
});
