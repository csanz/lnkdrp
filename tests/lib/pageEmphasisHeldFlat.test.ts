import { describe, expect, it } from "vitest";

import { heldFlatShown } from "@/components/metrics/pageEmphasis";
import { computeCallouts } from "@/lib/analytics/reading/pageTable";
import type { PageRow } from "@/lib/analytics/reading/types";

function row(page: number, typicalMs: number | null, readCount = 16): PageRow {
  return {
    page,
    label: null,
    shortLabel: null,
    thumbUrl: null,
    reached: 40,
    readCount,
    typicalMs,
    fewMs: null,
    passed: 0,
    jumped: 0,
    leftHere: 0,
    stillReading: 40,
  };
}

describe("heldFlatShown", () => {
  it("lists every page that prints the same time as the tied pages (Harborline shape)", () => {
    const pages = [row(1, 6652), row(2, 7688), row(3, 11291), row(4, 11450), row(5, 10796)];
    const flat = { pages: [3, 4], typicalMs: 11370, restTypicalMs: 7688 };
    expect(heldFlatShown(flat, pages)).toEqual({ pages: [3, 4, 5], typicalMs: 11291, restTypicalMs: 7170 });
  });

  it("agrees with whatever the API sends for the Harborline rows", () => {
    const pages = [row(1, 6652), row(2, 7688), row(3, 11291), row(4, 11450), row(5, 10796)];
    const flat = computeCallouts(pages, 40, 5)?.heldFlat;
    if (!flat) return;
    const shown = heldFlatShown(flat, pages);
    expect(shown.pages).toEqual([3, 4, 5]);
    expect(shown.restTypicalMs).toBe(7170);
  });

  it("drops the rest figure when a remaining page would print the listed figure", () => {
    // Listed 10.4s and 11.6s give "about 11s"; page 1 at 10.6s also prints 11s and joins, page 2 stays apart.
    const pages = [row(1, 10_600), row(2, 5_000), row(3, 10_400), row(4, 11_600)];
    const shown = heldFlatShown({ pages: [3, 4], typicalMs: 11_000, restTypicalMs: 7_800 }, pages);
    expect(shown.pages).toEqual([1, 3, 4]);
    expect(shown.restTypicalMs).toBe(5_000);
  });

  it("leaves thin pages out and keeps the lift branch as sent", () => {
    const pages = [row(1, 11_000, 2), row(2, 7_000), row(3, 11_200), row(4, 11_400)];
    expect(heldFlatShown({ pages: [3, 4], typicalMs: 11_300, restTypicalMs: 7_000 }, pages).pages).toEqual([3, 4]);
    const lift = { pages: [2, 3, 4], typicalMs: 11_200, restTypicalMs: null };
    expect(heldFlatShown(lift, pages)).toBe(lift);
  });

  it("omits the rest figure when nothing is left", () => {
    const pages = [row(1, 10_700), row(2, 11_000), row(3, 11_300)];
    expect(heldFlatShown({ pages: [2, 3], typicalMs: 11_150, restTypicalMs: 10_700 }, pages)).toEqual({
      pages: [1, 2, 3],
      typicalMs: 11_000,
      restTypicalMs: null,
    });
  });
});
