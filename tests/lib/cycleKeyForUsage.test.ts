/**
 * The admin credits page must look up `UsageAggCycle` with the key the charging path writes
 * (code review 2026-09-23, M10). The two keys that exist are pinned side by side so nobody
 * confuses them again.
 */
import { describe, expect, it } from "vitest";

import { cycleKeyForUsage, startOfUtcMonth, usageCycleStart } from "@/lib/credits/cycleKey";
import { buildCycleKey } from "@/lib/credits/grants";

const WORKSPACE = "aaaaaaaaaaaaaaaaaaaaaaaa";
const PERIOD_START = new Date("2026-09-03T10:15:00.000Z");

describe("cycleKeyForUsage", () => {
  it("is the workspace id and the ISO period start, which is what usage rows carry", () => {
    expect(cycleKeyForUsage({ workspaceId: WORKSPACE, cycleStart: PERIOD_START })).toBe(
      `${WORKSPACE}:2026-09-03T10:15:00.000Z`,
    );
  });

  it("is not the grant key, which is keyed on the Stripe subscription", () => {
    const usage = cycleKeyForUsage({ workspaceId: WORKSPACE, cycleStart: PERIOD_START });
    const grant = buildCycleKey({ stripeSubscriptionId: "sub_123", currentPeriodStart: PERIOD_START });
    expect(grant).toBe(`sub_123:${Math.floor(PERIOD_START.getTime() / 1000)}`);
    expect(usage).not.toBe(grant);
  });

  it("uses the balance row's period start when there is one, else the UTC month", () => {
    const now = new Date("2026-09-25T18:00:00.000Z");
    expect(usageCycleStart(PERIOD_START, now)).toEqual(PERIOD_START);
    expect(usageCycleStart(null, now)).toEqual(new Date("2026-09-01T00:00:00.000Z"));
    expect(usageCycleStart(undefined, now)).toEqual(startOfUtcMonth(now));
    expect(usageCycleStart(new Date("nonsense"), now)).toEqual(startOfUtcMonth(now));
  });
});
