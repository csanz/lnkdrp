/**
 * Two-slot verdict (spec §3.6) on the hand-built fixtures.
 */
import { describe, expect, test } from "vitest";

import { buildVerdict } from "@/lib/analytics/reading";

import { F1, F11, F12, F2, F3, F5, F6, F7, F8, SK1, fixture, personOf, type Fixture } from "./fixtures/readingFixtures";

const text = (fx: Fixture) => buildVerdict(personOf(fx), fx.P).text;

describe("buildVerdict", () => {
  test.each([
    ["F1", F1, "Went through all 4 pages. Went back to page 3."],
    ["F2", F2, "Stopped at page 3 of 5. Spent longest on page 3 (25s)."],
    ["F3", F3, "Stopped at page 3 of 4. Went back to page 2."],
    ["F5", F5, "Left on page 1."],
    ["F6", F6, "Reached the last page, skipping 2 of 6 pages. Came back 2 days later."],
    ["F7", F7, "Stopped at page 2 of 4."],
    ["F8", F8, "Read all 3 pages."],
    ["F11", F11, "Read the only page."],
    ["F12", F12, "Went through all 3 pages. Passed over page 2 quickly."],
    ["SK1", SK1, "Went through all 10 pages. Passed over pages 1–9 quickly."],
  ])("%s", (_name, fx, expected) => {
    expect(text(fx)).toBe(expected);
  });

  test("slots", () => {
    expect(buildVerdict(personOf(F1), 4)).toEqual({
      coverage: "Went through all 4 pages",
      behaviour: "Went back to page 3",
      text: "Went through all 4 pages. Went back to page 3.",
    });
    expect(buildVerdict(personOf(F7), 4).behaviour).toBeNull();
  });

  test("no detail", () => {
    const p = { ...personOf(F1), hasDetail: false };
    expect(buildVerdict(p, 4)).toEqual({ coverage: null, behaviour: null, text: "No page detail was recorded for this person." });
  });

  test("labels are appended to behaviour pages", () => {
    expect(buildVerdict(personOf(F2), 5, (p) => (p === 3 ? "Pricing" : null)).text).toBe(
      "Stopped at page 3 of 5. Spent longest on page 3 · Pricing (25s).",
    );
    expect(buildVerdict(personOf(F3), 4, (p) => (p === 2 ? "Team" : null)).behaviour).toBe("Went back to page 2 · Team");
  });

  test("P=1 without enough time went through the only page", () => {
    const fx = fixture(1, [{ name: "short", visits: [{ events: [[1, 5000, "pagehide"]] }] }]);
    expect(text(fx)).toBe("Went through the only page.");
  });

  test("longest run of passed pages wins, earliest on ties", () => {
    const fx = fixture(8, [
      {
        name: "runs",
        visits: [{ events: [[1, 5000, "turn"], [2, 500, "turn"], [3, 5000, "turn"], [4, 500, "turn"], [5, 500, "turn"], [6, 5000, "turn"], [7, 500, "turn"], [8, 5000, "pagehide"]] }],
      },
    ]);
    expect(buildVerdict(personOf(fx), 8).behaviour).toBe("Passed over pages 4–5 quickly");
  });
});
