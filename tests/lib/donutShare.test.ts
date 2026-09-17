import { describe, expect, it } from "vitest";

import { formatShare } from "@/lib/charts/donut";

/** The legend's percentages: the donut's arcs are recharts', but these numbers are ours. */
describe("formatShare", () => {
  it("rounds to whole percents", () => {
    expect(formatShare(0.42)).toBe("42%");
    expect(formatShare(0.5)).toBe("50%");
    expect(formatShare(1)).toBe("100%");
  });

  it("never shows a slice with any value as 0%", () => {
    expect(formatShare(0.0004)).toBe("<1%");
  });

  it("handles nothing at all", () => {
    expect(formatShare(0)).toBe("0%");
    expect(formatShare(Number.NaN)).toBe("0%");
    expect(formatShare(-1)).toBe("0%");
  });
});
