/**
 * Page table, callouts, typical page time and the callout gate (spec §3.4) on PT1.
 */
import { describe, expect, test } from "vitest";

import { calloutGateText, computeCallouts, computePageTable, median, typicalPageMs } from "@/lib/analytics/reading";

import type { PageRow } from "@/lib/analytics/reading";

import { ISAAC, PT1, peopleOf } from "./fixtures/readingFixtures";

const meta = [1, 2, 3, 4].map((page) => ({ page, label: null, shortLabel: null, thumbUrl: null }));

function row(page: number, o: Partial<PageRow>): PageRow {
  return { page, label: null, shortLabel: null, thumbUrl: null, reached: 0, readCount: 0, typicalMs: null, fewMs: null, passed: 0, jumped: 0, leftHere: 0, stillReading: 0, ...o };
}

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
    expect(rows.map((r) => r.jumped)).toEqual([0, 0, 0, 0]);
  });

  test("fewMs lists stayed dwells, longest first, only below the typical-time threshold", () => {
    expect(rows.map((r) => r.fewMs)).toEqual([null, null, [20000, 8000], [9000, 6000]]);
  });

  test("readPages per person", () => {
    expect(people.map((p) => p.readPages)).toEqual([4, 2, 1, 2, 3]);
  });

  test("totalMs per person", () => {
    expect(people.map((p) => p.totalMs)).toEqual([49000, 24000, 3000, 47800, 21500]);
  });

  test("callouts", () => {
    expect(computeCallouts(rows, 5, 4)).toEqual({
      // Page 2's 30s comes from only 3 people, and page 1 alone is no standout against itself.
      heldLongest: null,
      heldFlat: null,
      mostSkipped: { page: 3, skipped: 2, of: 4, tiedPages: [3] },
      mostLeft: { page: 3, leftHere: 2, people: 5, tiedPages: [3] },
    });
  });

  test("PT1 minus E: callouts null, left-here sums to people", () => {
    const four = people.filter((p) => p.key !== PT1.keys[4]);
    const r = computePageTable(four, 4, meta);
    expect(computeCallouts(r, four.length, 4)).toBeNull();
    expect(r.reduce((s, x) => s + x.leftHere, 0)).toBe(4);
  });

  test("mostLeft is null for single-page docs", () => {
    const one = [row(1, { reached: 5, readCount: 5, typicalMs: 1000, leftHere: 5, stillReading: 5 })];
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
    const r = computePageTable(people, 4, [{ page: 2, label: "Pricing: Plans and tiers", shortLabel: "Pricing", thumbUrl: "https://x/2.png" }]);
    expect(r[1].label).toBe("Pricing: Plans and tiers");
    expect(r[1].shortLabel).toBe("Pricing");
    expect(r[1].thumbUrl).toBe("https://x/2.png");
    expect(r[0].label).toBeNull();
  });
});

describe("held attention longest", () => {
  const P = 12;
  // Lumen shape: pages 10 and 11 at about 46s, every other page about 20s.
  const lumen = () =>
    Array.from({ length: P }, (_, i) => {
      const page = i + 1;
      if (page === 10) return row(page, { readCount: 14, typicalMs: 46000, stillReading: 20 });
      if (page === 11) return row(page, { readCount: 13, typicalMs: 45500, stillReading: 20 });
      if (page === 2) return row(page, { readCount: 3, typicalMs: 90000, stillReading: 20 });
      return row(page, { readCount: 15, typicalMs: 20000 + page, stillReading: 20 });
    });

  test("only pages at least 5 people stayed on; near ties within 5% are listed with their own counts", () => {
    expect(computeCallouts(lumen(), 20, P)?.heldLongest).toEqual({
      page: 10,
      typicalMs: 46000,
      readCount: 14,
      tiedPages: [10, 11],
      tied: [
        { page: 10, typicalMs: 46000, readCount: 14 },
        { page: 11, typicalMs: 45500, readCount: 13 },
      ],
    });
    const few = lumen().map((r) => ({ ...r, readCount: Math.min(r.readCount, 4) }));
    expect(computeCallouts(few, 20, P)?.heldLongest).toBeNull();
  });

  test("Harborline shape: three of five pages tie and none clears the median, so nothing is highlighted", () => {
    const rows = [
      row(1, { readCount: 38, typicalMs: 6100, stillReading: 40 }),
      row(2, { readCount: 30, typicalMs: 7688, stillReading: 35 }),
      row(3, { readCount: 29, typicalMs: 11291, stillReading: 32 }),
      row(4, { readCount: 18, typicalMs: 11007, stillReading: 25 }),
      row(5, { readCount: 15, typicalMs: 11012, stillReading: 20 }),
    ];
    expect(computeCallouts(rows, 40, 5)?.heldLongest).toBeNull();
    expect(computeCallouts(rows, 40, 5)?.heldFlat).toEqual({ pages: [3, 4, 5], typicalMs: 11012, restTypicalMs: 6894 });
  });

  test("a page that prints the same typical time as the leader counts as tied (live Harborline rows)", () => {
    const typicals = [6652, 7688, 11291, 11450, 10796];
    const rows = typicals.map((typicalMs, i) => row(i + 1, { readCount: 5 + i, typicalMs, stillReading: 20 }));
    expect(computeCallouts(rows, 40, 5)).toMatchObject({ heldLongest: null, heldFlat: { pages: [3, 4, 5], typicalMs: 11291, restTypicalMs: 7170 } });
  });

  test("heldFlat names the tied pages against the rest, or every eligible page when none lifts", () => {
    const typicals = [6652, 7688, 11291, 11007, 11012];
    const rows = typicals.map((typicalMs, i) => row(i + 1, { readCount: 5 + i, typicalMs, stillReading: 20 }));
    expect(computeCallouts(rows, 40, 5)).toMatchObject({ heldLongest: null, heldFlat: { pages: [3, 4, 5], typicalMs: 11012, restTypicalMs: 7170 } });
    // Low lift: one leader, but under 1.25× the median of the six eligible pages.
    const flat = Array.from({ length: 6 }, (_, i) => row(i + 1, { readCount: 9, typicalMs: i === 2 ? 12000 : 10000 }));
    expect(computeCallouts(flat, 9, 6)?.heldFlat).toEqual({ pages: [1, 2, 3, 4, 5, 6], typicalMs: 10000, restTypicalMs: null });
    // A highlighted leader carries no heldFlat; nor does a single eligible page, which has nothing to be flat against.
    expect(computeCallouts(lumen(), 20, P)).toMatchObject({ heldLongest: { page: 10 }, heldFlat: null });
    const one = rows.map((r) => (r.page === 3 ? r : { ...r, readCount: 4 }));
    expect(computeCallouts(one, 40, 5)).toMatchObject({ heldLongest: null, heldFlat: null });
    const none = rows.map((r) => ({ ...r, readCount: 4 }));
    expect(computeCallouts(none, 40, 5)).toMatchObject({ heldLongest: null, heldFlat: null });
  });

  test("more tied pages than a third of the document, or a leader under 1.25× the median, is null", () => {
    // Four pages within 5% on a 12-page doc: over CALLOUT_MAX_TIED.
    const four = lumen().map((r) => (r.page === 9 || r.page === 12 ? { ...r, typicalMs: 45000 } : r));
    expect(computeCallouts(four, 20, P)?.heldLongest).toBeNull();
    // Two tied pages on a 5-page doc: over floor(5 / 3) = 1.
    const small = [row(1, { readCount: 9, typicalMs: 10000 }), row(2, { readCount: 9, typicalMs: 10000 }), row(3, { readCount: 9, typicalMs: 30000 }), row(4, { readCount: 9, typicalMs: 29000 }), row(5, { readCount: 9, typicalMs: 10000 })];
    expect(computeCallouts(small, 9, 5)?.heldLongest).toBeNull();
    expect(computeCallouts(small.map((r) => (r.page === 4 ? { ...r, typicalMs: 10000 } : r)), 9, 5)?.heldLongest).toMatchObject({ page: 3, tiedPages: [3] });
    // A clear single leader that is only 1.2× the median.
    const flat = Array.from({ length: 6 }, (_, i) => row(i + 1, { readCount: 9, typicalMs: i === 2 ? 12000 : 10000 }));
    expect(computeCallouts(flat, 9, 6)?.heldLongest).toBeNull();
  });
});

describe("jumped pages and skip/left callouts", () => {
  test("a jumper counts as jumped, never reached, and jumped = stillReading − reached", () => {
    const people = peopleOf(ISAAC);
    const rows = computePageTable(people, 13, []);
    expect(rows.map((r) => r.jumped)).toEqual([0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0]);
    expect(rows.map((r) => r.reached)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]);
    for (const r of rows) expect(r.jumped).toBe(r.stillReading - r.reached);
  });

  test("most skipped ranks by share of people still reading, then count; passed and jumped both count", () => {
    const rows = [
      row(1, { stillReading: 9, passed: 2 }),
      row(2, { stillReading: 6, passed: 1, jumped: 1 }),
      row(3, { stillReading: 6, passed: 3 }),
      row(4, { stillReading: 3, jumped: 2 }),
    ];
    expect(computeCallouts(rows, 9, 4)?.mostSkipped).toEqual({ page: 4, skipped: 2, of: 3, tiedPages: [4] });
    rows[3] = row(4, { stillReading: 4, jumped: 2 });
    expect(computeCallouts(rows, 9, 4)?.mostSkipped).toEqual({ page: 3, skipped: 3, of: 6, tiedPages: [3] });
  });

  test("the cover is excluded when P > 2, allowed when P = 2", () => {
    const rows = [row(1, { stillReading: 10, passed: 8 }), row(2, { stillReading: 6, passed: 2 }), row(3, { stillReading: 5, passed: 1 })];
    expect(computeCallouts(rows, 10, 3)?.mostSkipped?.page).toBe(2);
    expect(computeCallouts(rows.slice(0, 2), 10, 2)?.mostSkipped?.page).toBe(1);
  });

  test("exact ties list every tied page; more than three tied means no highlight", () => {
    const tied = [row(1, { stillReading: 9 }), row(2, { stillReading: 6, passed: 2, leftHere: 2 }), row(3, { stillReading: 6, jumped: 2, leftHere: 2 }), row(4, { stillReading: 6 })];
    const c = computeCallouts(tied, 9, 4);
    expect(c?.mostSkipped).toEqual({ page: 2, skipped: 2, of: 6, tiedPages: [2, 3] });
    expect(c?.mostLeft).toEqual({ page: 2, leftHere: 2, people: 9, tiedPages: [2, 3] });

    const many = [1, 2, 3, 4, 5, 6].map((p) => row(p, { stillReading: 6, passed: p > 1 ? 2 : 0, leftHere: p < 6 ? 2 : 0 }));
    expect(computeCallouts(many, 10, 6)?.mostSkipped).toBeNull();
    expect(computeCallouts(many, 10, 6)?.mostLeft).toBeNull();
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
