/**
 * The client copy mirror has to agree with the server constants.
 *
 * `src/lib/billing/planLimits.ts` and `src/lib/credits/grants.ts` both import Mongoose models, so a
 * client bundle cannot read them. `src/lib/client/planLimit.ts` therefore keeps a hand-written copy
 * of the same numbers for the pricing card, the billing tab and the upgrade prompts — and nothing
 * connected the two, so the copy was free to go stale while the enforcement moved.
 *
 * It did. Raising the Free grant to 100 credits, Pro to 500, documents to 10 and projects to 2 left
 * every one of these mirrored values pointing at the old plan: screens kept promising 3 documents
 * and 50 credits while the server granted more. Nothing failed, because nothing was checking.
 *
 * This is that check. It asserts the two sides are equal rather than asserting any particular
 * number, so a deliberate pricing change stays a one-line edit on each side and an accidental
 * one-sided edit fails here.
 */
import { describe, expect, test, vi } from "vitest";

import { CREDITS_COPY, COMPARE_CREDITS, FREE_PLAN_LIMITS_COPY } from "@/lib/client/planNumbers";

/** Both server modules reach for Mongo at import time; the constants themselves are plain values. */
async function serverConstants() {
  vi.doMock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
  const planLimits = await import("@/lib/billing/planLimits");
  const grants = await import("@/lib/credits/grants");
  const creditService = await import("@/lib/credits/creditService");
  return { ...planLimits, ...grants, ...creditService };
}

describe("client copy mirrors the server plan constants", () => {
  test("the Free caps on screen are the Free caps enforced", async () => {
    const { FREE_DOCUMENTS, FREE_PROJECTS, FREE_ANALYTICS_DAYS } = await serverConstants();

    expect(FREE_PLAN_LIMITS_COPY.documents).toBe(FREE_DOCUMENTS);
    expect(FREE_PLAN_LIMITS_COPY.projects).toBe(FREE_PROJECTS);
    expect(FREE_PLAN_LIMITS_COPY.analyticsDays).toBe(FREE_ANALYTICS_DAYS);
  });

  test("the compare prices the copy divides by are the prices charged", async () => {
    // "about 100 standard compares" is `proPerMonth / 5`. If the schedule ever reprices a tier, that
    // sentence becomes wrong on six surfaces at once with nothing to catch it.
    const { creditsForRun } = await import("@/lib/credits/schedule");

    for (const tier of ["basic", "standard", "advanced"] as const) {
      expect(COMPARE_CREDITS[tier]).toBe(creditsForRun({ actionType: "history", qualityTier: tier }));
    }
  });

  test("the credit numbers on screen are the credits granted", async () => {
    const { FREE_STARTER_CREDITS, INCLUDED_CREDITS_PER_CYCLE, FREE_DAILY_CREDIT_CAP } = await serverConstants();

    expect(CREDITS_COPY.freeStarter).toBe(FREE_STARTER_CREDITS);
    expect(CREDITS_COPY.proPerMonth).toBe(INCLUDED_CREDITS_PER_CYCLE);
    expect(CREDITS_COPY.freeDailyCap).toBe(FREE_DAILY_CREDIT_CAP);
  });
});
