import { describe, expect, it } from "vitest";

import { fillDays, fmtMoney, onDemandCents, priceLabelToCents, trendPct } from "@/lib/admin/revenue";

/** The admin home reports run-rate and charges; none of it may be invented when a figure is missing. */
describe("revenue helpers", () => {
  it("reads a stored price label as cents, and refuses to guess", () => {
    expect(priceLabelToCents("$29/mo")).toBe(2900);
    expect(priceLabelToCents("$29.00 per month")).toBe(2900);
    expect(priceLabelToCents("$1,199/yr")).toBe(119900); // a thousands comma is grouping, not a decimal point
    expect(priceLabelToCents("$29.5/mo")).toBe(2950); // one decimal digit means tenths
    expect(priceLabelToCents("")).toBeNull();
    expect(priceLabelToCents(null)).toBeNull();
    expect(priceLabelToCents("talk to us")).toBeNull();
  });

  it("prices on-demand credits the way the workspace is billed", () => {
    expect(onDemandCents(0)).toBe(0);
    expect(onDemandCents(12)).toBe(120);
    expect(onDemandCents(-5)).toBe(0);
  });

  it("fills every day in the window so a gap in sales stays visible", () => {
    const since = new Date("2026-09-01T12:00:00Z");
    const until = new Date("2026-09-05T12:00:00Z");
    const out = fillDays([{ day: "2026-09-03", packCents: 500, onDemandCents: 20 }], since, until);
    expect(out.map((d) => d.day)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"]);
    expect(out[2]).toEqual({ day: "2026-09-03", packCents: 500, onDemandCents: 20 });
    expect(out[0]).toEqual({ day: "2026-09-01", packCents: 0, onDemandCents: 0 });
  });

  it("has no trend to report against an empty previous window", () => {
    expect(trendPct(100, 0)).toBeNull();
    expect(trendPct(150, 100)).toBe(50);
    expect(trendPct(50, 100)).toBe(-50);
  });

  it("formats money for a tile, and an unknown figure as a dash", () => {
    expect(fmtMoney(5800)).toBe("$58");
    expect(fmtMoney(123456)).toBe("$1,235");
    expect(fmtMoney(250)).toBe("$2.50");
    expect(fmtMoney(null)).toBe("–");
    expect(fmtMoney(undefined)).toBe("–");
  });
});
