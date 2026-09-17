/**
 * Side-panel people-by-day bars: tick choice and value-label spacing.
 */
import { describe, expect, test } from "vitest";

import { chartTicks, valueLabelIndexes } from "@/components/docQuickStatsChart";

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
});
