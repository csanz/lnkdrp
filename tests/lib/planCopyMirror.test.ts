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
import { UPSELL_COPY } from "@/lib/client/upsellCopy";
import { describe, expect, test, vi } from "vitest";

import { CREDITS_COPY, COMPARE_CREDITS, FREE_PLAN_LIMITS_COPY, PRO_SEATS_COPY } from "@/lib/client/planNumbers";

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
    const { FREE_DOCUMENTS, FREE_PROJECTS, FREE_ANALYTICS_DAYS, FREE_SLACK_CHANNELS } = await serverConstants();

    expect(FREE_PLAN_LIMITS_COPY.documents).toBe(FREE_DOCUMENTS);
    expect(FREE_PLAN_LIMITS_COPY.projects).toBe(FREE_PROJECTS);
    expect(FREE_PLAN_LIMITS_COPY.analyticsDays).toBe(FREE_ANALYTICS_DAYS);
    expect(FREE_PLAN_LIMITS_COPY.slackChannels).toBe(FREE_SLACK_CHANNELS);
  });

  test("the compare prices the copy divides by are the prices charged", async () => {
    // "about 100 standard compares" is `proPerMonth / 5`. If the schedule ever reprices a tier, that
    // sentence becomes wrong on six surfaces at once with nothing to catch it.
    const { creditsForRun } = await import("@/lib/credits/schedule");

    for (const tier of ["basic", "standard", "advanced"] as const) {
      expect(COMPARE_CREDITS[tier]).toBe(creditsForRun({ actionType: "history", qualityTier: tier }));
    }
  });

  test("the seat count on screen is the seat count enforced", async () => {
    const { PRO_INCLUDED_COLLABORATORS } = await serverConstants();
    expect(PRO_SEATS_COPY).toBe(PRO_INCLUDED_COLLABORATORS);
  });

  test("the credit numbers on screen are the credits granted", async () => {
    const { FREE_STARTER_CREDITS, INCLUDED_CREDITS_PER_CYCLE, FREE_DAILY_CREDIT_CAP } = await serverConstants();

    expect(CREDITS_COPY.freeStarter).toBe(FREE_STARTER_CREDITS);
    expect(CREDITS_COPY.proPerMonth).toBe(INCLUDED_CREDITS_PER_CYCLE);
    expect(CREDITS_COPY.freeDailyCap).toBe(FREE_DAILY_CREDIT_CAP);
  });
});

describe("the upgrade modal quotes the same numbers", () => {
  /**
   * The mirror test above compares `planNumbers.ts` to the server constants, and that was enough
   * right up until it wasn't: `upsellCopy.ts` wrote the same numbers out inside prose, where no
   * comparison could see them. Raising Free to 10 documents and Pro to 500 credits left the upgrade
   * modal — the one screen whose entire job is explaining what you get for paying — still saying 3
   * documents and 300 credits.
   *
   * These assert the rendered strings carry the current numbers and none of the retired ones, so
   * the prose cannot drift from the constants it is describing.
   */
  test("no upsell string quotes a retired plan number", () => {
    const blob = JSON.stringify(UPSELL_COPY);
    for (const stale of ["3 documents", "300 AI credits", "300 credits", "limited to 1 on Free", "get one project"]) {
      expect(blob, `retired copy still present: ${stale}`).not.toContain(stale);
    }
  });

  test("the document and project caps come from the mirror", () => {
    const docs = UPSELL_COPY.documents;
    expect(docs.reason).toContain(`${FREE_PLAN_LIMITS_COPY.documents} documents`);
    const projects = UPSELL_COPY.projects;
    expect(projects.title).toContain(String(FREE_PLAN_LIMITS_COPY.projects));
    expect(projects.reason).toContain(`${FREE_PLAN_LIMITS_COPY.projects} projects`);
  });

  test("the Pro credit allowance comes from the mirror", () => {
    const blob = JSON.stringify(UPSELL_COPY);
    expect(blob).toContain(`${CREDITS_COPY.proPerMonth} AI credits a month`);
  });

  test("the seat count comes from the mirror, and the generic pitch mentions seats at all", () => {
    // Seats were typed out as a literal "3 teammates" the same day the constant moved from 1 to 3,
    // in the file whose own docstring warns against exactly that. And the `pro` pitch — the modal
    // someone sees when they press Upgrade with no specific wall in front of them — listed
    // documents, analytics and credits, and never mentioned that Pro is what lets anyone else in.
    const blob = JSON.stringify(UPSELL_COPY);
    expect(blob).toContain(`${PRO_SEATS_COPY} teammates`);
    expect(blob).not.toMatch(/\b1 collaborator included\b/);
    expect(UPSELL_COPY.pro.bullets.join(" "), "the generic Pro pitch says nothing about seats").toMatch(/teammates|viewers/);
  });
});
