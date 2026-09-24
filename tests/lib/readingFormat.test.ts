/**
 * Duration/gap/date wording, page labels and the days parameter (spec §3.7–3.8).
 */
import { describe, expect, test } from "vitest";

import {
  formatCountOf,
  formatDwell,
  formatDwellCompact,
  formatTypical,
  dwellRatio,
  formatGap,
  formatRelative,
  formatReturnGap,
  dayKeyInZone,
  dayKeysBetween,
  pageLabel,
  pageLabelParts,
  pageMetaFromDoc,
  parseDaysParam,
  parseTimeZoneParam,
  rangeLabel,
} from "@/lib/analytics/reading";

describe("formatDwell", () => {
  test.each([
    [null, "–"],
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

describe("formatTypical", () => {
  test.each([
    [null, "–"],
    [undefined, "–"],
    [600, "<1s"],
    [4677, "4.7s"],
    [5000, "5s"],
    [7864, "7.9s"],
    [9949, "9.9s"],
    [9960, "10s"],
    [11291, "11s"],
    [46738, "47s"],
    [59600, "1m"],
    [65000, "1m 5s"],
  ])("%s → %s", (ms, expected) => {
    expect(formatTypical(ms as number | null | undefined)).toBe(expected);
  });
});

describe("formatDwellCompact", () => {
  test.each([
    [null, "–"],
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
    [70 * 3_600_000, "3 days"],
    [70 * 3_600_000 - 50_000, "3 days"],
    [326_601_507, "4 days"],
    [36 * 3_600_000 - 1, "1 day"],
    [90 * 60_000, "1 hour"],
    [30_000, "1 minute"],
    [5 * 60_000, "5 minutes"],
    [5 * 3_600_000, "5 hours"],
    [24 * 3_600_000, "1 day"],
  ])("%s → %s", (ms, expected) => {
    expect(formatGap(ms)).toBe(expected);
  });
});

describe("formatReturnGap", () => {
  const LA = "America/Los_Angeles";
  const at = (iso: string) => Date.parse(iso);
  test.each([
    // 08:00 Sep 10 → 22:00 Sep 10 in Los Angeles.
    ["2026-09-10T15:00:00.000Z", 14 * 3_600_000, "14 hours later"],
    // 08:00 Sep 10 → 23:00 Sep 11: 39h across one local midnight.
    ["2026-09-10T15:00:00.000Z", 39 * 3_600_000, "the next day"],
    // 03:09 Aug 28 → 22:45 Aug 30: 67.6h across two local midnights.
    ["2026-08-28T10:09:00.000Z", 67.6 * 3_600_000, "2 days later"],
    // 23:30 Sep 10 → 00:30 Sep 12: 25h across two local midnights.
    ["2026-09-11T06:30:00.000Z", 25 * 3_600_000, "2 days later"],
    ["2026-09-10T15:00:00.000Z", 30_000, "1 minute later"],
    ["2026-09-10T15:00:00.000Z", 12 * 60_000, "12 minutes later"],
    ["2026-09-10T15:00:00.000Z", 90 * 60_000, "1 hour later"],
  ])("%s + %s → %s", (from, gap, expected) => {
    expect(formatReturnGap(at(from), at(from) + gap, LA)).toBe(expected);
  });

  test("the same instants count days in the zone given", () => {
    const from = at("2026-09-10T15:00:00.000Z");
    expect(formatReturnGap(from, from + 39 * 3_600_000, "UTC")).toBe("2 days later");
    // 00:00 Sep 11 → 15:00 Sep 12 in Tokyo.
    expect(formatReturnGap(from, from + 39 * 3_600_000, "Asia/Tokyo")).toBe("the next day");
    expect(formatReturnGap(from, from + 39 * 3_600_000, LA)).toBe("the next day");
  });
});

describe("dwellRatio", () => {
  test("floors to one decimal without float drift", () => {
    expect(dwellRatio(40000, 4000)).toBe(10);
    expect(dwellRatio(70000, 8000)).toBe(8.7);
    expect(dwellRatio(104000, 7000)).toBe(14.8);
    expect(dwellRatio(20000, 7000)).toBe(2.8);
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
    expect(formatRelative(t, now, "UTC")).toBe(expected);
    expect(formatRelative(new Date(t).toISOString(), now, "UTC")).toBe(expected);
  });

  test("a day or more counts calendar days in the zone, like the day charts", () => {
    const LA = "America/Los_Angeles";
    // Sep 13 8:53 PM → Sep 17 4:25 AM in Los Angeles: 79.5h, but four calendar days.
    expect(formatRelative(Date.parse("2026-09-14T03:53:54.000Z"), Date.parse("2026-09-17T11:25:00.000Z"), LA)).toBe("4 days ago");
    // 11:30 PM → 12:30 AM the next day is still an hour.
    expect(formatRelative(Date.parse("2026-09-11T06:30:00.000Z"), Date.parse("2026-09-11T07:30:00.000Z"), LA)).toBe("1 h ago");
    // Noon Sep 10 → 1 PM Sep 11: 25h across one midnight.
    expect(formatRelative(Date.parse("2026-09-10T19:00:00.000Z"), Date.parse("2026-09-11T20:00:00.000Z"), LA)).toBe("yesterday");
    // 11 PM Sep 10 → 10 PM Sep 12: 47h across two midnights.
    expect(formatRelative(Date.parse("2026-09-11T06:00:00.000Z"), Date.parse("2026-09-13T05:00:00.000Z"), LA)).toBe("2 days ago");
    // Dates are the zone's calendar date.
    expect(formatRelative(Date.parse("2026-09-01T03:00:00.000Z"), Date.parse("2026-09-17T11:25:00.000Z"), LA)).toBe("Aug 31");
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
    expect(pageLabel("unit--overview")).toBe("Unit overview");
    expect(pageLabel("a".repeat(80))).toHaveLength(80);
    const long = pageLabel("a".repeat(120));
    expect(long).toHaveLength(90);
    expect(long?.endsWith("…")).toBe(true);
    // Cut at the last whole word before 90 characters.
    expect(pageLabel("market-the-opportunity-in-remote-patient-monitoring-for-cardiology-clinics-across-rural-and-urban-hospital-systems-nationwide")).toBe(
      "Market: The opportunity in remote patient monitoring for cardiology clinics across rural…",
    );
  });

  test("collapses a repeated leading word or pair, spells P&L and acronyms, drops tiny results", () => {
    expect(pageLabel("traction-traction-enrolled-patients")).toBe("Traction: Enrolled patients");
    expect(pageLabel("market-size-market-size-tam")).toBe("Market: Size TAM");
    expect(pageLabel("financials-p-l-and-burn")).toBe("Financials: P&L and burn");
    expect(pageLabel("Unit_economics-roi")).toBe("Unit economics ROI");
    expect(pageLabel("gtm-plan-and-arr-mrr-kpi")).toBe("GTM plan and ARR MRR KPI");
    expect(pageLabel("team-team")).toBe("Team");
    expect(pageLabel("growth-growth-plan")).toBe("Growth plan");
    expect(pageLabel("arrival-kpis")).toBe("Arrival kpis");
    expect(pageLabel("x")).toBeNull();
    expect(pageLabel("ab")).toBeNull();
  });

  test("role slugs read 'Role: Heading', or the role alone when the heading only repeats it", () => {
    for (const [slug, label, shortLabel] of [
      ["team-the-team", "Team", "Team"],
      ["cover-series-a-deck-lumen-health", "Cover", "Cover"],
      ["competition-competitive-landscape", "Competition: Competitive landscape", "Competition"],
      ["business-model-revenue-model", "Business model: Revenue model", "Business model"],
      ["ask-use-of-funds", "Ask: Use of funds", "Ask"],
      ["problem-why-cardiology-clinics-are-stuck-today", "Problem: Why cardiology clinics are stuck today", "Problem"],
      ["proposal-what-we-propose", "Proposal", "Proposal"],
      ["traction-mwh-under-management", "Traction: MWh under management", "Traction"],
      ["recommendations-next-steps", "Recommendations: Next steps", "Recommendations"],
      ["incident-response-runbook", "Incident response: Runbook", "Incident response"],
      ["roi-payback-period", "ROI: Payback period", "ROI"],
      ["customers", "Customers", "Customers"],
      ["unit-economics-cac-payback", "Unit economics cac payback", "Unit economics cac payback"],
    ] as const) {
      expect(pageLabelParts(slug), slug).toEqual({ label, shortLabel });
    }
    expect(pageLabelParts("page-3")).toBeNull();
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
      { page: 1, label: null, shortLabel: null, thumbUrl: "https://t/1.png" },
      { page: 2, label: "Pricing", shortLabel: "Pricing", thumbUrl: null },
      { page: 3, label: null, shortLabel: null, thumbUrl: null },
    ]);
  });
});

describe("time zones and day keys", () => {
  test("parseTimeZoneParam accepts known IANA zones only", () => {
    expect(parseTimeZoneParam(null)).toBe("UTC");
    expect(parseTimeZoneParam("")).toBe("UTC");
    expect(parseTimeZoneParam("UTC")).toBe("UTC");
    expect(parseTimeZoneParam("America/Los_Angeles")).toBe("America/Los_Angeles");
    expect(parseTimeZoneParam("Mars/Olympus")).toBe("UTC");
    expect(parseTimeZoneParam("<script>")).toBe("UTC");
  });

  test("dayKeyInZone uses the local calendar day", () => {
    const t = Date.parse("2026-08-31T05:47:00.000Z");
    expect(dayKeyInZone(t, "America/Los_Angeles")).toBe("2026-08-30");
    expect(dayKeyInZone(t, "UTC")).toBe("2026-08-31");
    expect(dayKeyInZone(t, "Asia/Tokyo")).toBe("2026-08-31");
  });

  test("dayKeysBetween is inclusive and crosses months", () => {
    expect(dayKeysBetween("2026-08-30", "2026-09-02")).toEqual(["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"]);
    expect(dayKeysBetween("2026-09-02", "2026-09-01")).toEqual([]);
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
