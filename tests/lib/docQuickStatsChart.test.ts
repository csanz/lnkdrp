/**
 * Side-panel people-by-day bars: tick choice and value-label spacing.
 */
import { describe, expect, test } from "vitest";

import { chartTicks, peopleCluster, valueLabelIndexes } from "@/components/docQuickStatsChart";

const labels = Array.from({ length: 31 }, (_, i) => `Aug ${i + 1}`);

describe("chartTicks", () => {
  test("spread-out activity keeps first, middle and last", () => {
    const values = labels.map((_, i) => (i % 3 === 0 ? 1 : 0));
    expect(chartTicks(values, labels, 260).map((t) => t.index)).toEqual([0, 15, 30]);
  });

  test("a narrow cluster swaps the midpoint for its first and last active day", () => {
    const values = labels.map((_, i) => (i >= 8 && i <= 16 ? 2 : 0));
    const ticks = chartTicks(values, labels, 260);
    expect(ticks.map((t) => t.index)).toEqual([0, 8, 16, 30]);
    expect(ticks.find((t) => t.index === 0)?.anchor).toBe("start");
    expect(ticks.find((t) => t.index === 30)?.anchor).toBe("end");
  });

  test("ticks that would overlap are dropped, the last active day before the first", () => {
    const values = labels.map((_, i) => (i === 13 || i === 14 ? 1 : 0));
    const ticks = chartTicks(values, labels, 260);
    expect(ticks.map((t) => t.index)).toEqual([0, 14, 30]);
  });

  test("activity on the last day needs no extra tick", () => {
    const values = labels.map((_, i) => (i === 30 ? 1 : 0));
    expect(chartTicks(values, labels, 260).map((t) => t.index)).toEqual([0, 30]);
  });

  test("a short cluster ending today labels its first day to the left of the bars", () => {
    const sep = Array.from({ length: 31 }, (_, i) => (i < 14 ? `Aug ${i + 18}` : `Sep ${i - 13}`));
    const values = sep.map((_, i) => (i >= 26 ? [3, 20, 13, 3, 1][i - 26]! : 0));
    const ticks = chartTicks(values, sep, 261);
    expect(ticks.map((t) => [sep[t.index], t.anchor])).toEqual([
      ["Aug 18", "start"],
      ["Sep 13", "end"],
      ["Sep 17", "end"],
    ]);
    // Right edge of "Sep 13" sits at the left edge of its bar; "Sep 17" ends at the chart edge.
    const slot = (261 - 4) / 31;
    expect(ticks[1]!.dx).toBeCloseTo(-slot / 2);
    expect(2 + slot * 30.5 + ticks[2]!.dx).toBeCloseTo(259);
  });

  test("a short cluster's start date wins over the range's first day when they collide", () => {
    const values = labels.map((_, i) => (i >= 6 && i <= 10 ? 1 : 0));
    const ticks = chartTicks(values, labels, 261);
    expect(ticks.map((t) => [t.index, t.anchor])).toEqual([
      [6, "end"],
      [10, "middle"],
      [30, "end"],
    ]);
  });

  test("a cluster longer than a week still gives up its start date to the range's first day", () => {
    const values = labels.map((_, i) => (i >= 5 && i <= 12 ? 1 : 0));
    expect(chartTicks(values, labels, 261).map((t) => t.index)).toEqual([0, 12, 30]);
  });

  test("empty data has no ticks", () => {
    expect(chartTicks([], [], 260)).toEqual([]);
  });
});

describe("valueLabelIndexes", () => {
  test("adjacent bars under 10px apart keep only the larger value", () => {
    expect([...valueLabelIndexes([0, 1, 3, 0], 8)]).toEqual([2]);
  });

  test("equal values: the earlier bar wins", () => {
    expect([...valueLabelIndexes([1, 1], 8)]).toEqual([0]);
  });

  test("wide slots label every bar", () => {
    expect([...valueLabelIndexes([1, 2, 3], 20)].sort()).toEqual([0, 1, 2]);
  });

  test("wide numbers need more room than the 10px floor", () => {
    expect([...valueLabelIndexes([120, 110], 12)]).toEqual([0]);
  });

  test("a clustered series that cannot label every bar labels only the peak", () => {
    // Lumen: 15/11/4/1/1 on the last five days of 30, in a ~260px rail.
    const values = Array.from({ length: 30 }, (_, i) => (i >= 25 ? [15, 11, 4, 1, 1][i - 25]! : 0));
    expect([...valueLabelIndexes(values, 8.5)]).toEqual([25]);
  });

  test("never labels a smaller bar while a larger one goes blank", () => {
    // Greedy placement would have kept 4 at index 4 after skipping 11 at index 1.
    expect([...valueLabelIndexes([15, 11, 0, 0, 4], 8.5)]).toEqual([0]);
  });

  test("a clustered series whose labels all fit labels every bar", () => {
    const values = Array.from({ length: 30 }, (_, i) => (i >= 25 ? [15, 11, 4, 1, 1][i - 25]! : 0));
    expect([...valueLabelIndexes(values, 16)].sort((a, b) => a - b)).toEqual([25, 26, 27, 28, 29]);
  });
});

describe("peopleCluster", () => {
  test("the shortest run of days holding 90% of people", () => {
    // 41 people, 36.9 needed: 3+20+13 = 36 falls short, 20+13+4 = 37 is enough.
    expect(peopleCluster([1, 3, 20, 13, 4, 0])).toEqual({ from: 2, to: 4, people: 37, total: 41 });
  });

  test("equal runs with equal people: the earlier one", () => {
    expect(peopleCluster([1, 3, 20, 13, 3, 0])).toEqual({ from: 1, to: 3, people: 36, total: 40 });
  });

  test("a cluster holding everyone", () => {
    expect(peopleCluster([0, 0, 5, 2, 0])).toEqual({ from: 2, to: 3, people: 7, total: 7 });
  });

  test("equal-length runs prefer more people", () => {
    expect(peopleCluster([4, 0, 5], 0.5)).toEqual({ from: 2, to: 2, people: 5, total: 9 });
  });

  test("nobody counted", () => {
    expect(peopleCluster([0, 0])).toBeNull();
    expect(peopleCluster([])).toBeNull();
  });
});
