import { describe, expect, it } from "vitest";

import { cellStep, formatCellDwell } from "@/components/metrics/matrixScale";

describe("cellStep", () => {
  it("buckets on fixed absolute boundaries", () => {
    expect(cellStep(0)).toBe(0);
    expect(cellStep(1_999)).toBe(0);
    expect(cellStep(2_000)).toBe(1);
    expect(cellStep(4_999)).toBe(1);
    expect(cellStep(5_000)).toBe(2);
    expect(cellStep(14_999)).toBe(2);
    expect(cellStep(15_000)).toBe(3);
    expect(cellStep(29_999)).toBe(3);
    expect(cellStep(30_000)).toBe(4);
    expect(cellStep(59_999)).toBe(4);
    expect(cellStep(60_000)).toBe(5);
    expect(cellStep(600_000)).toBe(5);
  });

  it("does not depend on other cells: 10s and 47s differ", () => {
    expect(cellStep(10_000)).not.toBe(cellStep(47_000));
  });

  it("treats unusable values as under 2s", () => {
    expect(cellStep(Number.NaN)).toBe(0);
    expect(cellStep(-5)).toBe(0);
  });
});

describe("formatCellDwell", () => {
  it("keeps whole seconds up to 999s, so 76s and 118s read in one unit", () => {
    expect(formatCellDwell(2_000)).toBe("2s");
    expect(formatCellDwell(78_000)).toBe("78s");
    expect(formatCellDwell(99_999)).toBe("99s");
    expect(formatCellDwell(118_000)).toBe("118s");
    expect(formatCellDwell(206_000)).toBe("206s");
    expect(formatCellDwell(999_999)).toBe("999s");
  });

  it("switches to minutes with one decimal from 1000s and whole hours from 60m", () => {
    expect(formatCellDwell(1_000_000)).toBe("16.6m");
    expect(formatCellDwell(1_040_000)).toBe("17.3m");
    expect(formatCellDwell(3_599_999)).toBe("59.9m");
    expect(formatCellDwell(3_600_000)).toBe("1h");
  });

  it("treats unusable values as 0s", () => {
    expect(formatCellDwell(Number.NaN)).toBe("0s");
    expect(formatCellDwell(-1)).toBe("0s");
  });
});
