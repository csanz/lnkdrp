/**
 * Duration/gap/date wording, page labels and the days parameter (spec §3.7–3.8).
 */
import { describe, expect, test } from "vitest";

import {
  formatCountOf,
  formatDwell,
  formatDwellCompact,
  formatGap,
  formatRelative,
  pageLabel,
  pageMetaFromDoc,
  parseDaysParam,
  rangeLabel,
} from "@/lib/analytics/reading";

describe("formatDwell", () => {
  test.each([
    [null, "—"],
    [0, "0s"],
    [-5, "0s"],
    [999, "<1s"],
    [1000, "1s"],
    [28729, "28s"],
    [59999, "59s"],
    [60000, "1m"],
    [99900, "1m 39s"],
    [600000, "10m"],
    [3599999, "59m"],
    [3600000, "1h"],
    [3900000, "1h 5m"],
  ])("%s → %s", (ms, expected) => {
    expect(formatDwell(ms as number | null)).toBe(expected);
  });
});

describe("formatDwellCompact", () => {
  test.each([
    [null, "—"],
    [500, "<1s"],
    [12_500, "12s"],
    [250_000, "4m"],
    [7_300_000, "2h"],
  ])("%s → %s", (ms, expected) => {
    expect(formatDwellCompact(ms as number | null)).toBe(expected);
  });
});

describe("formatGap", () => {
  test.each([
    [70 * 3_600_000, "2 days"],
    [90 * 60_000, "1 hour"],
    [30_000, "1 minute"],
    [5 * 60_000, "5 minutes"],
    [5 * 3_600_000, "5 hours"],
    [24 * 3_600_000, "1 day"],
  ])("%s → %s", (ms, expected) => {
    expect(formatGap(ms)).toBe(expected);
  });
});

describe("formatRelative", () => {
  const now = Date.parse("2026-09-17T15:00:00.000Z");
  test.each([
    [now + 5000, "just now"],
    [now - 59_000, "just now"],
    [now - 5 * 60_000, "5 min ago"],
    [now - 3 * 3_600_000, "3 h ago"],
    [now - 30 * 3_600_000, "yesterday"],
    [now - 4 * 86_400_000, "4 days ago"],
  ])("%s → %s", (t, expected) => {
    expect(formatRelative(t, now)).toBe(expected);
    expect(formatRelative(new Date(t).toISOString(), now)).toBe(expected);
  });

  test("older dates use the short month and add the year when it differs", () => {
    const sameYear = new Date(2026, 8, 1, 12, 0, 0).getTime();
    expect(formatRelative(sameYear, now)).toBe("Sep 1");
    const lastYear = new Date(2025, 8, 10, 12, 0, 0).getTime();
    expect(formatRelative(lastYear, now)).toBe("Sep 10, 2025");
  });
});

describe("small helpers", () => {
  test("formatCountOf and rangeLabel", () => {
    expect(formatCountOf(3, 4)).toBe("3 of 4");
    expect(rangeLabel(7)).toBe("7 days");
    expect(rangeLabel(30)).toBe("30 days");
    expect(rangeLabel(90)).toBe("90 days");
    expect(rangeLabel(365)).toBe("12 months");
    expect(rangeLabel(14)).toBe("14 days");
  });
});

describe("pageLabel", () => {
  test("generic slugs have no label", () => {
    expect(pageLabel("")).toBeNull();
    expect(pageLabel(null)).toBeNull();
    expect(pageLabel("page-12")).toBeNull();
    expect(pageLabel("last-page")).toBeNull();
  });

  test("humanises and truncates", () => {
    expect(pageLabel("pricing-and_plans")).toBe("Pricing and plans");
    expect(pageLabel("team--overview")).toBe("Team overview");
    const long = pageLabel("a".repeat(80));
    expect(long).toHaveLength(48);
    expect(long?.endsWith("…")).toBe(true);
  });

  test("pageMetaFromDoc", () => {
    const meta = pageMetaFromDoc(
      {
        slideNodes: [
          { pageNumber: 1, thumbUrl: "https://t/1.png" },
          { pageNumber: 2, thumbUrl: null },
        ],
        pageSlugs: [{ pageNumber: 2, slug: "pricing" }, { pageNumber: 1, slug: "page-1" }],
      },
      3,
    );
    expect(meta).toEqual([
      { page: 1, label: null, thumbUrl: "https://t/1.png" },
      { page: 2, label: "Pricing", thumbUrl: null },
      { page: 3, label: null, thumbUrl: null },
    ]);
  });
});

describe("parseDaysParam", () => {
  const pro = { plan: "pro", daysLimit: null };
  const free = { plan: "free", daysLimit: 7 };
  test.each([
    [pro, null, 30],
    [pro, "90", 90],
    [pro, "0", 1],
    [pro, "999", 365],
    [pro, "abc", 30],
    [free, null, 7],
    [free, "90", 7],
    [free, "3", 3],
  ])("%j %s → %s", (o, raw, expected) => {
    expect(parseDaysParam(raw, o)).toBe(expected);
  });
});
