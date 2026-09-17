import { describe, expect, it } from "vitest";

import { cellOpacity } from "@/components/metrics/matrixScale";

describe("cellOpacity", () => {
  it("is 0 for no time", () => {
    expect(cellOpacity(0, 5000)).toBe(0);
    expect(cellOpacity(-10, 5000)).toBe(0);
  });

  it("is 1 at the maximum", () => {
    expect(cellOpacity(5000, 5000)).toBe(1);
    expect(cellOpacity(600_000, 600_000)).toBe(1);
  });

  it("is 1 when the maximum is unusable", () => {
    expect(cellOpacity(3000, 0)).toBe(1);
  });

  it("puts a short stay low on a long scale", () => {
    const v = cellOpacity(1000, 600_000);
    expect(v).toBeGreaterThan(0.18);
    expect(v).toBeLessThan(0.5);
  });

  it("is monotonic and never above 1", () => {
    let prev = 0;
    for (let ms = 1; ms <= 700_000; ms += 997) {
      const v = cellOpacity(ms, 600_000);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
  });

  it("rounds to two decimals", () => {
    const v = cellOpacity(12_345, 99_999);
    expect(Math.round(v * 100) / 100).toBe(v);
  });
});
