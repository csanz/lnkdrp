/**
 * Page table, callouts, typical page time and the callout gate (spec §3.4) on PT1.
 */
import { describe, expect, test } from "vitest";

import { calloutGateText, computeCallouts, computePageTable, median, typicalPageMs } from "@/lib/analytics/reading";

import { PT1, peopleOf } from "./fixtures/readingFixtures";

const meta = [1, 2, 3, 4].map((page) => ({ page, label: null, thumbUrl: null }));

describe("median", () => {
  test("odd, even (floored midpoint), empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2])).toBe(1);
    expect(median([6000, 8000])).toBe(7000);
    expect(median([])).toBeNull();
  });
});

describe("computePageTable PT1", () => {
  const people = peopleOf(PT1);
  const rows = computePageTable(people, 4, meta);

  test("rows match the spec table", () => {
    expect(rows.map(({ page, reached, readCount, typicalMs, passed, leftHere, stillReading }) => [page, reached, readCount, typicalMs, passed, leftHere, stillReading])).toEqual([
      [1, 5, 5, 4000, 0, 1, 5],
      [2, 4, 3, 30000, 1, 0, 4],
      [3, 4, 2, null, 2, 2, 4],
      [4, 2, 2, null, 0, 2, 2],
    ]);
  });

  test("readPages per person", () => {
    expect(people.map((p) => p.readPages)).toEqual([4, 2, 1, 2, 3]);
  });

  test("totalMs per person", () => {
    expect(people.map((p) => p.totalMs)).toEqual([49000, 24000, 3000, 47800, 21500]);
  });

  test("callouts", () => {
    expect(computeCallouts(rows, 5, 4)).toEqual({
      heldLongest: { page: 2, typicalMs: 30000, readCount: 3 },
      mostPassed: { page: 3, passed: 2, reached: 4 },
      mostLeft: { page: 3, leftHere: 2, people: 5 },
    });
  });

  test("PT1 minus E: callouts null, left-here sums to people", () => {
    const four = people.filter((p) => p.key !== PT1.keys[4]);
    const r = computePageTable(four, 4, meta);
    expect(computeCallouts(r, four.length, 4)).toBeNull();
    expect(r.reduce((s, x) => s + x.leftHere, 0)).toBe(4);
  });

  test("mostLeft is null for single-page docs", () => {
    const one = [{ page: 1, label: null, thumbUrl: null, reached: 5, readCount: 5, typicalMs: 1000, passed: 0, leftHere: 5, stillReading: 5 }];
    expect(computeCallouts(one, 5, 1)?.mostLeft).toBeNull();
  });

  test("typicalPageMs with exclusions", () => {
    const [A, B, C, D, E] = PT1.keys;
    expect(typicalPageMs(people, null)).toEqual({ ms: 7000, people: 5 });
    expect(typicalPageMs(people, B)).toEqual({ ms: 7000, people: 4 });
    expect(typicalPageMs(people, C)).toEqual({ ms: 8000, people: 4 });
    expect(typicalPageMs(people, D)).toEqual({ ms: 7000, people: 4 });
    expect(typicalPageMs(people, E)).toEqual({ ms: 6000, people: 4 });
    expect(typicalPageMs(people, A).people).toBe(4);
    expect(typicalPageMs([], null)).toEqual({ ms: null, people: 0 });
  });

  test("page meta labels and thumbs are carried", () => {
    const r = computePageTable(people, 4, [{ page: 2, label: "Pricing", thumbUrl: "https://x/2.png" }]);
    expect(r[1].label).toBe("Pricing");
    expect(r[1].thumbUrl).toBe("https://x/2.png");
    expect(r[0].label).toBeNull();
  });
});

describe("calloutGateText", () => {
  test("exact strings", () => {
    expect(calloutGateText(0, 0)).toBeNull();
    expect(calloutGateText(3, 3)).toBe("Page highlights appear once 5 people have opened it.");
    expect(calloutGateText(6, 4)).toBe("Page highlights appear once 5 people have page detail.");
    expect(calloutGateText(6, 5)).toBeNull();
    expect(calloutGateText(4, 0)).toBeNull();
  });
});
