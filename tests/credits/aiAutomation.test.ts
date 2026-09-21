/**
 * The switch on the two AI runs nobody asks for.
 *
 * A summary is written for every upload and a compare for every replacement, and both spend credits
 * while the person is doing something else. Everything else in the product waits to be asked, so
 * these two are the only ones a setting can meaningfully turn off.
 *
 * What is pinned here is the direction the unknowns fall. A setting that reads "off" when it has
 * simply never been written would stop summarising for every workspace that existed before the
 * field did, and the symptom — uploads that quietly produce nothing — looks exactly like a broken
 * pipeline rather than a preference. So absent, null and malformed all mean on, and only a real
 * `false` means off.
 */
import { describe, expect, test } from "vitest";

import {
  AI_AUTOMATION_DEFAULT,
  isAutomationOn,
  parseAutomationFlag,
  resolveAiAutomation,
} from "@/lib/credits/aiAutomation";

describe("what counts as off", () => {
  test("only an explicit false", () => {
    expect(isAutomationOn(false)).toBe(false);
  });

  test("a row written before the field existed is on, not off", () => {
    // The whole reason the check is `!== false` rather than `=== true`.
    expect(isAutomationOn(undefined)).toBe(true);
    expect(isAutomationOn(null)).toBe(true);
  });

  test("a malformed value is on", () => {
    // Nothing writes these, but the read is defensive in the direction that keeps the product
    // working rather than the direction that silently stops it.
    for (const v of [0, "", "false", "off", {}, []]) expect(isAutomationOn(v)).toBe(true);
  });

  test("true is on", () => {
    expect(isAutomationOn(true)).toBe(true);
  });
});

describe("resolving a balance row", () => {
  test("no row at all means both on: the workspace has never run anything", () => {
    expect(resolveAiAutomation(null)).toEqual({ summary: true, compare: true });
    expect(resolveAiAutomation(null)).toEqual(AI_AUTOMATION_DEFAULT);
  });

  test("an empty row means both on", () => {
    expect(resolveAiAutomation({})).toEqual({ summary: true, compare: true });
  });

  test("the two switches are independent", () => {
    expect(resolveAiAutomation({ autoSummaryEnabled: false, autoCompareEnabled: true })).toEqual({
      summary: false,
      compare: true,
    });
    expect(resolveAiAutomation({ autoSummaryEnabled: true, autoCompareEnabled: false })).toEqual({
      summary: true,
      compare: false,
    });
  });

  test("both off is a state a workspace can be in", () => {
    expect(resolveAiAutomation({ autoSummaryEnabled: false, autoCompareEnabled: false })).toEqual({
      summary: false,
      compare: false,
    });
  });
});

describe("parsing what a caller sent", () => {
  test("only a real boolean counts", () => {
    expect(parseAutomationFlag(true)).toBe(true);
    expect(parseAutomationFlag(false)).toBe(false);
  });

  test("anything else is null, which the route reads as 'not specified'", () => {
    // This is what keeps the existing tier card — which posts neither field — from being read as
    // a request to switch both runs off.
    for (const v of [undefined, null, "true", "false", 1, 0, {}]) expect(parseAutomationFlag(v)).toBe(null);
  });
});
