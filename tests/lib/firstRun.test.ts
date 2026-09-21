/**
 * The rule that decides who sees `/welcome`.
 *
 * Worth its own tests because the expensive mistake is silent and large: get it wrong in one
 * direction and every existing account is sent through a setup screen it does not need, after it
 * has already named things and chosen its preferences.
 */
import { describe, expect, test } from "vitest";

import { FIRST_RUN_SINCE, needsFirstRun } from "@/lib/onboarding/firstRun";

const before = new Date(FIRST_RUN_SINCE.getTime() - 60_000);
const after = new Date(FIRST_RUN_SINCE.getTime() + 60_000);

describe("first-run setup", () => {
  test("a brand-new account that has not been through it", () => {
    expect(needsFirstRun({ onboardedAt: null, createdAt: after })).toBe(true);
  });

  test("an account that finished or skipped it never sees it again", () => {
    expect(needsFirstRun({ onboardedAt: new Date(), createdAt: after })).toBe(false);
    // Skip stamps the same field, so the two are indistinguishable here by design.
    expect(needsFirstRun({ onboardedAt: after, createdAt: after })).toBe(false);
  });

  test("an account from before the screen existed is treated as done", () => {
    // The flag is missing on every pre-existing row too, so without the cutoff this would be the
    // whole user base.
    expect(needsFirstRun({ onboardedAt: null, createdAt: before })).toBe(false);
  });

  test("an unknown creation date is left alone", () => {
    // An unwanted welcome screen in front of an established workspace is worse than a missed one.
    expect(needsFirstRun({ onboardedAt: null, createdAt: null })).toBe(false);
  });

  test("the cutoff instant itself counts as new", () => {
    expect(needsFirstRun({ onboardedAt: null, createdAt: new Date(FIRST_RUN_SINCE) })).toBe(true);
  });
});
