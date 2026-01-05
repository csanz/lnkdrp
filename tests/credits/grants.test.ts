import { describe, expect, test } from "vitest";

import { buildCycleKey } from "@/lib/credits/grants";

describe("credits/grants", () => {
  test("cycleKey uses unix seconds (stable, UTC)", () => {
    const d = new Date(Date.UTC(2026, 0, 4, 12, 34, 56)); // 2026-01-04T12:34:56.000Z
    const key = buildCycleKey({ stripeSubscriptionId: "sub_123", currentPeriodStart: d });
    expect(key).toBe(`sub_123:${Math.floor(d.getTime() / 1000)}`);
  });
});


