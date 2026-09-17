import { describe, expect, test } from "vitest";

import { donutArcs, formatShare, polarPoint } from "@/lib/charts/donut";

const OPTS = { size: 100, thickness: 20, gap: 0 };
const TAU = Math.PI * 2;

describe("donut geometry", () => {
  test("shares and angles cover the circle in the order given", () => {
    const arcs = donutArcs(
      [
        { key: "people", value: 50 },
        { key: "claude", value: 30 },
        { key: "cursor", value: 20 },
      ],
      OPTS,
    );
    expect(arcs.map((a) => a.key)).toEqual(["people", "claude", "cursor"]);
    expect(arcs.map((a) => a.share)).toEqual([0.5, 0.3, 0.2]);
    expect(arcs[0]?.startAngle).toBeCloseTo(0, 6);
    expect(arcs[0]?.endAngle).toBeCloseTo(TAU / 2, 6);
    expect(arcs[1]?.startAngle).toBeCloseTo(TAU / 2, 6);
    expect(arcs[2]?.endAngle).toBeCloseTo(TAU, 6);
    // Mid-angle sits between its own ends, which is where a label or leader line would hang.
    for (const a of arcs) expect(a.midAngle).toBeCloseTo((a.startAngle + a.endAngle) / 2, 6);
  });

  test("angles run clockwise from twelve o'clock", () => {
    // 0 is the top of the circle, a quarter turn is the right-hand side.
    expect(polarPoint(50, 50, 40, 0)).toEqual({ x: 50, y: 10 });
    expect(polarPoint(50, 50, 40, Math.PI / 2)).toEqual({ x: 90, y: 50 });
    expect(polarPoint(50, 50, 40, Math.PI)).toEqual({ x: 50, y: 90 });
  });

  test("a sector's path traces the outer arc, crosses to the inner radius and closes", () => {
    const [arc] = donutArcs([{ key: "a", value: 1 }, { key: "b", value: 3 }], OPTS);
    expect(arc?.path.startsWith("M 50 0")).toBe(true);
    expect(arc?.path).toContain("A 50 50 0 0 1");
    expect(arc?.path).toContain("A 30 30 0 0 0");
    expect(arc?.path.endsWith("Z")).toBe(true);
  });

  test("a slice over half the circle sets the large-arc flag", () => {
    const [big, small] = donutArcs([{ key: "big", value: 9 }, { key: "small", value: 1 }], OPTS);
    expect(big?.path).toContain("A 50 50 0 1 1");
    expect(small?.path).toContain("A 50 50 0 0 1");
  });

  test("a single 100% slice is drawn as a closed ring, not a degenerate arc", () => {
    const arcs = donutArcs([{ key: "people", value: 7 }], { ...OPTS, gap: 4 });
    expect(arcs).toHaveLength(1);
    const only = arcs[0]!;
    expect(only.share).toBe(1);
    expect(only.startAngle).toBe(0);
    expect(only.endAngle).toBeCloseTo(TAU, 6);
    // Two outer half-arcs plus two inner ones: a lone arc cannot close on itself.
    expect(only.path.match(/A 50 50/g)).toHaveLength(2);
    expect(only.path.match(/A 30 30/g)).toHaveLength(2);
    // No gap is taken out of a slice that has no neighbour to be separated from.
    expect(only.path).toContain("M 50 0");
  });

  test("zero, negative and empty totals draw nothing", () => {
    expect(donutArcs([], OPTS)).toEqual([]);
    expect(donutArcs([{ key: "a", value: 0 }, { key: "b", value: 0 }], OPTS)).toEqual([]);
    expect(donutArcs([{ key: "a", value: -3 }], OPTS)).toEqual([]);
    expect(donutArcs([{ key: "a", value: Number.NaN }], OPTS)).toEqual([]);
  });

  test("zero-value slices are dropped, so one real slice still becomes the full ring", () => {
    const arcs = donutArcs([{ key: "people", value: 5 }, { key: "agents", value: 0 }], OPTS);
    expect(arcs.map((a) => a.key)).toEqual(["people"]);
    expect(arcs[0]?.share).toBe(1);
  });

  test("the gap eats into neighbouring slices without inverting the smallest one", () => {
    const wide = donutArcs([{ key: "a", value: 1 }, { key: "b", value: 1 }], { ...OPTS, gap: 4 });
    expect(wide[0]!.startAngle).toBeGreaterThan(0);
    expect(wide[0]!.endAngle).toBeLessThan(Math.PI);
    // A hair-thin slice next to a huge one never runs backwards.
    const lopsided = donutArcs([{ key: "a", value: 10_000 }, { key: "b", value: 1 }], { ...OPTS, gap: 12 });
    for (const a of lopsided) expect(a.endAngle).toBeGreaterThanOrEqual(a.startAngle);
  });

  test("shares read as percentages, and a real slice is never rounded away to 0%", () => {
    expect(formatShare(0.5)).toBe("50%");
    expect(formatShare(0.333)).toBe("33%");
    expect(formatShare(0.0001)).toBe("<1%");
    expect(formatShare(0)).toBe("0%");
    expect(formatShare(1)).toBe("100%");
  });
});
