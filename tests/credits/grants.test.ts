import { describe, expect, test } from "vitest";

import { FREE_STARTER_CREDITS, INCLUDED_CREDITS_PER_CYCLE, buildCycleKey } from "@/lib/credits/grants";

describe("credits/grants", () => {
  test("cycleKey uses unix seconds (stable, UTC)", () => {
    const d = new Date(Date.UTC(2026, 0, 4, 12, 34, 56)); // 2026-01-04T12:34:56.000Z
    const key = buildCycleKey({ stripeSubscriptionId: "sub_123", currentPeriodStart: d });
    expect(key).toBe(`sub_123:${Math.floor(d.getTime() / 1000)}`);
  });

  test("Free gets a one-time 100-credit starter grant, Pro gets 500 per cycle", () => {
    // Raised from 50/300 on 2026-09-21. The grants are deliberately generous against their real
    // cost: every tier runs `gpt-4o-mini`, so 100 credits of Free usage is well under a dollar and
    // 500 on Pro is a small fraction of the $29. The numbers are here, in a test, because they are
    // a pricing decision rather than a constant — changing one should be a visible act.
    expect(FREE_STARTER_CREDITS).toBe(100);
    expect(INCLUDED_CREDITS_PER_CYCLE).toBe(500);
  });
});
