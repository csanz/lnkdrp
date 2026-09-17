import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { aboveTypicalRow, aboveTypicalText, agoText, longestPages, longestPagesText, stayedOnFact } from "@/components/metrics/reader/ReaderFacts";
import { pageBarDomainMs, typicalValueText, valueSubLineChars } from "@/components/metrics/reader/ReaderPageBars";
import ReaderSheetBody from "@/components/metrics/reader/ReaderSheetBody";
import { earlierGapText, visitPathText, visitTopPagesText } from "@/components/metrics/reader/VisitTimeline";
import { formatRelative } from "@/lib/analytics/reading/format";
import type { PersonPageRow, PersonResponse } from "@/lib/analytics/reading/types";
import { personResponseF1, personResponseF6, personResponsePT1A } from "./fixtures/readingFixtures";

const noop = () => {};

function render(data: PersonResponse, now = Date.parse(data.person.lastSeen) + 3_600_000): string {
  return renderToStaticMarkup(
    React.createElement(ReaderSheetBody, {
      data,
      callbacks: { onClose: noop, onFilterLink: noop },
      filteredShareId: null,
      now,
    }),
  );
}

/** Visible text with tags removed, so copy split across nowrap spans still matches. */
function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function count(html: string, re: RegExp): number {
  return (html.match(re) ?? []).length;
}

function verdictText(html: string): string | null {
  const m = html.match(/<div[^>]*\bdata-verdict\b[^>]*>([^<]*)<\/div>/);
  return m ? m[1] : null;
}

function expectNoForbiddenCopy(html: string) {
  expect(html).not.toMatch(/[0-9a-f]{64}/);
  expect(html).not.toMatch(/Activity span|best-effort|Avg \/ page/);
  expect(html).not.toMatch(/Read \d+ of/);
  expect(html).not.toMatch(/\bviews\b/);
}

describe("ReaderSheetBody render", () => {
  it("F1: verdict, stayed chip, four page rows, exit path, no typical ticks", () => {
    const html = render(personResponseF1);
    expect(verdictText(html)?.replace(/\u00a0/g, " ")).toBe("Went through all 4 pages. Went back to page 3.");
    expect(html).toContain("Stayed on 4 of 4 pages");
    expect(html).toContain("Page 3");
    expect(count(html, /data-reader-page=/g)).toBe(4);
    expect(html).toContain("left on page 3");
    expect(count(html, /data-typical-tick/g)).toBe(0);
    expect(html).not.toContain(">typical<");
    expect(html).toContain("↺ went back");
    expect(html).toContain("Left here");
    expect(html).toContain("data-ribbon");
    expect(html).toContain('aria-label="Close"');
    expect(text(html)).toContain("Didn't give a name");
    expect(text(html)).toContain("Link: Default link");
    expect(html).not.toContain(" · via ");
    // The verdict comes before the actions.
    expect(html.indexOf("data-verdict")).toBeLessThan(html.indexOf(">Copy link<"));
    expectNoForbiddenCopy(html);
  });

  it("F6: newest visit first with an earlier divider, visit numbers and last-page ending", () => {
    const html = render(personResponseF6);
    const plain = text(html);
    const [newer, older] = personResponseF6.visits;
    const divider = earlierGapText(Date.parse(older.endedAt), Date.parse(newer.startedAt));
    expect(divider).toMatch(/ earlier$|^the day before$/);
    expect(html).toContain(`>${divider}<`);
    expect(html).not.toContain("came back");
    expect(plain.indexOf("Visit 2 of 2")).toBeLessThan(plain.indexOf("Visit 1 of 2"));
    expect(html).toContain("ended on the last page");
    expect(html).toContain("Under 2s: page 1");
    expect(plain.indexOf("5 → 6")).toBeLessThan(plain.indexOf("1 → 2 · left on page 2"));
    expect(count(html, /data-reader-page=/g)).toBe(6);
    expect(personResponseF6.pages.filter((p) => p.state === "jumped").map((p) => p.page)).toEqual([3, 4]);
    expect(count(html, />Jumped past</g)).toBe(2);
    expect(html).not.toContain("Not reached");
    expect(plain).toContain("Pages 5 → 6");
    expect(html).toContain('<span class="whitespace-nowrap">→ 6 · ended on the last page</span>');
    expectNoForbiddenCopy(html);
  });

  it("PT1-A: typical ticks only on pages with a typical time, plus the header key", () => {
    const html = render(personResponsePT1A);
    const withTypical = personResponsePT1A.pages.filter((p) => p.typicalMs !== null);
    expect(withTypical.length).toBeGreaterThan(0);
    const tickPages = withTypical.filter((p) => p.state === "read");
    expect(count(html, /data-typical-tick/g)).toBe(tickPages.length);
    expect(count(html, />typical \d/g)).toBe(withTypical.filter((p) => p.state !== "unreached").length);
    expect(html).toContain("their time");
    expect(html).toContain(">typical<");
    expect(html).not.toContain("typical for others");
    // The key sits in the section header, before the first page row.
    expect(html.indexOf("data-page-bars-key")).toBeLessThan(html.indexOf("data-reader-page="));
    expectNoForbiddenCopy(html);
  });

  it("untimed visits, identities, downloads and the earlier-versions footnote", () => {
    const base = personResponseF1;
    const data: PersonResponse = {
      ...base,
      multipleVersions: true,
      person: { ...base.person, source: "introduced", name: "Dana Lee", email: "dana@example.test", downloads: 2, activeNow: true },
      pages: base.pages.map((p) => ({ ...p, state: p.page <= 2 ? "unknown" : "unreached", ms: 0, revisits: 0, leftHere: false })),
      visits: [{ ...base.visits[0], timed: false, stops: [], seen: [1, 2], exitPage: 2, exitInferred: true, passedPages: [] }],
    };
    const html = render(data);
    expect(html).toContain("Time on pages wasn&#x27;t recorded for this visit.");
    expect(html).toContain("Pages seen: 1–2");
    expect(count(html, />Time not recorded</g)).toBe(2);
    expect(html).toContain("Not reached");
    expect(html).toContain(">dana@example.test · entered by the reader, not verified<");
    expect(html).toContain("Active in the last 10 minutes");
    expect(html).not.toContain("Stayed on 4 of 4 pages");
    expect(html).toContain("Copy email");
    expect(html).toContain('href="mailto:dana@example.test?subject="');
    expect(html).toContain(">Email Dana<");
    expect(html).toContain("Downloads");
    expect(html).toContain("Includes reads of earlier versions.");
    expectNoForbiddenCopy(html);
  });

  it("hides Only this link when already filtered to the person's link", () => {
    const filtered = renderToStaticMarkup(
      React.createElement(ReaderSheetBody, {
        data: personResponseF1,
        callbacks: { onClose: noop, onFilterLink: noop },
        filteredShareId: personResponseF1.person.shareId,
        now: Date.parse(personResponseF1.person.lastSeen),
      }),
    );
    expect(filtered).not.toContain("Only this link");
    expect(render(personResponseF1)).toContain("Only this link");
  });

  it("collapses to five visits with a show-earlier button", () => {
    const base = personResponseF6.visits[1];
    const visits = Array.from({ length: 7 }, (_, i) => ({
      ...base,
      visitId: `v${i}`,
      startedAt: new Date(Date.parse(base.startedAt) - i * 2 * 3_600_000).toISOString(),
      endedAt: new Date(Date.parse(base.endedAt) - i * 2 * 3_600_000).toISOString(),
    }));
    const html = render({ ...personResponseF6, visits });
    expect(count(html, /data-reader-visit/g)).toBe(5);
    expect(html).toContain("Show 2 earlier visits");
  });
  it("page rows: passed '<2s', jumped past, untimed exit with Left here, and a 30s bar floor", () => {
    const base = personResponseF1;
    const data: PersonResponse = {
      ...base,
      pages: base.pages.map((p) => {
        if (p.page === 1) return { ...p, state: "read", ms: 5_000, revisits: 0, leftHere: false, typicalMs: null };
        if (p.page === 2) return { ...p, state: "passed", ms: 0, revisits: 0, leftHere: false, typicalMs: null };
        if (p.page === 3) return { ...p, state: "jumped", ms: 0, revisits: 0, leftHere: false, typicalMs: null };
        return { ...p, state: "unknown", ms: 0, revisits: 0, leftHere: true, typicalMs: null };
      }),
    };
    const html = render(data);
    expect(html).toContain(">&lt;2s<");
    expect(html).not.toMatch(/>0s</);
    expect(html).toContain(">Jumped past<");
    expect(html).not.toContain(">Skipped<");
    expect(html).toContain(">Time not recorded<");
    expect(html).toContain("width:16.666666666666664%");
    // Every value cell has two lines, so rows without a typical time stay aligned with the bar.
    expect(count(html, /whitespace-nowrap text-\[11px\][^>]*>\u00a0</g)).toBe(4);
    const row4 = html.slice(html.indexOf('data-reader-page="4"'));
    expect(row4).toContain("Left here");
  });

  it("header hides a chip that repeats the verdict and facts lead with exit and longest pages", () => {
    const now = Date.parse(personResponseF6.person.lastSeen) + 3_600_000;
    const html = render(personResponseF6, now);
    expect(personResponseF6.person.hot).not.toBeNull();
    expect(count(html, /data-reader-chip/g)).toBe(personResponseF6.person.activeNow ? 1 : 0);
    expect(html).toContain(">Left on<");
    expect(html).toContain(">Longest pages<");
    expect(text(html)).toContain("Page 6 50s,Page 5 40s");
    expect(longestPagesText(personResponseF6.pages, personResponseF6.visits)).toBe("Page 6 50s, Page 5 40s");
    expect(html).toContain(">Visits<");
    expect(html).toContain(`latest ${formatRelative(personResponseF6.person.lastSeen, now)}`);
    const seen = personResponseF6.person.lastSeen;
    expect(agoText(seen, Date.parse(seen) + 3 * 86_400_000)).toBe("3 days ago");
    expect(agoText(seen, Date.parse(seen) + 12 * 86_400_000)).toBe("12 days ago");
    expect(agoText(seen, Date.parse(seen) + 95 * 86_400_000)).toBe("3 months ago");
    expect(html).not.toContain(">Opened<");
    expect(html).not.toContain(">Link<");
    expect(html).not.toContain("first opened");
    expect(html).toContain(">Stayed on<");
    expect(html).toContain(">2 jumped past<");
    expect(html).not.toMatch(/\d skipped/);
  });

  it("visit path keeps passed steps inline and lists the longest pages", () => {
    const base = personResponseF1;
    const visit = {
      ...base.visits[0],
      exitPage: 2,
      passedPages: [4],
      stops: [
        { page: 1, ms: 7_000, revisit: false, passed: false, untimed: false },
        { page: 4, ms: 0, revisit: false, passed: true, untimed: false },
        { page: 3, ms: 17_000, revisit: false, passed: false, untimed: false },
        { page: 2, ms: 47_000, revisit: false, passed: false, untimed: false },
      ],
    };
    const html = render({ ...base, visits: [visit] });
    expect(text(html)).toContain("Pages 1 → 4 (under 2s) → 3 → 2 · left on page 2");
    expect(html).toContain("Page 2 47s · Page 3 17s · Page 1 7s");
    expect(visitTopPagesText({ ...visit, stops: visit.stops.slice(0, 3) })).toBeNull();
    expect(html).not.toContain("Passed: page");
    expect(html).toContain("flex:0 0 8px");
    expect(html).toContain("--seg-flex:7000 1 0px");
    // Three timed stops at the 6px floor plus one 8px under-2s stop and three 2px gaps.
    expect(html).toContain("--ribbon-min:32px");
    expect(html).toContain("min-width:6px");
    expect(html).toContain("hatched = under 2s");
    expect(html).not.toContain("stop 1 of");
  });

  it("an untimed final step reads 'time not recorded', never passed", () => {
    const base = personResponseF1;
    const visit = {
      ...base.visits[0],
      exitPage: 4,
      passedPages: [],
      stops: [
        { page: 1, ms: 9_000, revisit: false, passed: false, untimed: false },
        { page: 2, ms: 0, revisit: false, passed: false, untimed: true },
        { page: 3, ms: 0, revisit: false, passed: false, untimed: true },
        { page: 4, ms: 0, revisit: false, passed: false, untimed: true },
      ],
    };
    const html = render({ ...base, visits: [visit] });
    expect(text(html)).toContain("Pages 1 → 2, 3, 4 (time not recorded) · ended on the last page");
    expect(html).toContain('aria-label="Page 4 · time not recorded"');
    expect(html).not.toContain("(under 2s)");
    expect(html).toContain("flex:0 0 16px");
    expect(html).toContain("dotted = time not recorded");
    expect(html).not.toContain("hatched = under 2s");
    // A long ending wraps as one phrase, never "· ended on" / "the last page".
    expect(html).toContain('<span class="whitespace-nowrap">· ended on the last page</span>');
    expect(visitPathText({ ...visit, stops: [visit.stops[0], visit.stops[3]] }, 12)).toBe(
      "Pages 1 → 4 (time not recorded) · left on page 4",
    );
  });

  it("ribbon width follows visit length against the longest shown visit or the typical person", () => {
    const f6 = { ...personResponseF6, facts: { ...personResponseF6.facts, typicalTotalMs: null } };
    const html = render(f6);
    // f6-v2 is 90s (the longest), f6-v1 50s.
    expect(html).toContain("--ribbon-w:100%");
    expect(html).toContain(`--ribbon-w:${(50_000 / 90_000) * 100}%`);
    expect(html).not.toContain("data-typical-visit");
    const short = { ...f6.visits[1], totalMs: 2_000 };
    expect(render({ ...f6, visits: [f6.visits[0], short] })).toContain(`--ribbon-w:${(2_000 / 90_000) * 100}%`);
    // A typical person longer than every visit becomes the reference and draws its marker.
    const typical = render({ ...f6, facts: { ...f6.facts, typicalTotalMs: 180_000 } });
    expect(typical).toContain("--ribbon-w:50%");
    expect(count(typical, /data-typical-visit/g)).toBe(2);
    expect(typical).toContain(">typical person 3m<");
  });

  it("collapses runs of three or more unreached pages behind Show pages, keeping every row in the DOM", () => {
    const base = personResponseF1;
    const pages = Array.from({ length: 8 }, (_, i) => ({
      ...base.pages[0],
      page: i + 1,
      state: (i < 2 ? "read" : "unreached") as "read" | "unreached",
      ms: i < 2 ? 8_000 : 0,
      leftHere: i === 1,
    }));
    const data: PersonResponse = {
      ...base,
      pageCount: 8,
      pages,
      facts: { ...base.facts, visits: 1, maxPage: 2, reachedCount: 2, exitPage: 2, typicalTotalMs: 41_000 },
    };
    const html = render(data);
    expect(html).toContain("Pages 3–8");
    expect(html).toContain(" · not reached");
    expect(html).toContain(">Show pages<");
    expect(count(html, /data-reader-page=/g)).toBe(8);
    expect(count(html, /<li[^>]*hidden=""/g)).toBe(6);
    // A matrix cell for a collapsed page opens the range.
    const revealed = renderToStaticMarkup(
      React.createElement(ReaderSheetBody, { data, callbacks: { onClose: noop }, filteredShareId: null, now: Date.now(), focusPage: 5 }),
    );
    expect(count(revealed, /<li[^>]*hidden=""/g)).toBe(0);
    expect(revealed).toContain(">Hide pages<");
    // A one-visit bounce trades the page facts and Pages reached for the typical person's total.
    expect(html).not.toContain(">Longest pages<");
    expect(html).not.toContain(">Pages reached<");
    expect(html).toContain(">Typical person<");
    expect(html).toContain(">41s<");
    // Two unreached pages stay as rows.
    const two = render({ ...data, pageCount: 4, pages: pages.slice(0, 4) });
    expect(two).not.toContain("Show pages");
    expect(count(two, />Not reached</g)).toBe(2);
  });

  it("bar scale ignores a lone outlier, caps it with a break and shows above-typical time", () => {
    const base = personResponseF1;
    const row = (page: number, ms: number, typicalMs: number | null, ratio: number | null = null) => ({
      ...base.pages[0],
      page,
      ms,
      typicalMs,
      ratio,
      readCount: 8,
      state: "read" as const,
    });
    const pages = [row(1, 20_000, 8_000, 2.5), row(2, 170_541, 7_700, 22.1), row(3, 10_000, null), row(4, 15_000, null)];
    expect(pageBarDomainMs(pages)).toBe(40_000);
    expect(pageBarDomainMs([row(1, 5_000, null)])).toBe(30_000);
    expect(typicalValueText(pages[1])).toBe("typical 7.7s · 22.1×");
    expect(typicalValueText(row(1, 12_000, 8_000, 1.5))).toBe("typical 8s");
    // The ratio only ever comes from the API: none there, none shown.
    expect(typicalValueText(row(1, 40_000, 8_000, null))).toBe("typical 8s");
    const html = render({ ...base, pages });
    expect(html).toContain("width:100%");
    expect(html).toContain(">›<");
    expect(count(html, /data-above-typical/g)).toBe(2);
    expect(html).toContain(">more than typical<");
    expect(count(html, /data-tick-muted/g)).toBe(0);
    const few = render({ ...base, pages: [{ ...row(1, 5_000, 8_000), readCount: 3 }, row(2, 6_000, 9_000)] });
    expect(count(few, /data-typical-tick/g)).toBe(2);
    expect(count(few, /data-tick-muted/g)).toBe(1);
    expect(few).not.toContain("more than typical");
  });

  it("Samuel: a skipped page's typical time and one 170s outlier don't shrink the pages that held him", () => {
    const base = personResponseF1;
    const read = (page: number, ms: number, typicalMs: number) => ({
      ...base.pages[0],
      page,
      ms,
      typicalMs,
      readCount: 9,
      ratio: null,
      state: "read" as const,
    });
    const pages = [
      read(5, 34_200, 12_000),
      read(6, 37_200, 15_000),
      read(8, 170_541, 30_500),
      { ...base.pages[0], page: 10, ms: 0, state: "jumped" as const, typicalMs: 57_898, readCount: 9, ratio: null },
      read(12, 39_000, 20_000),
    ];
    const domain = pageBarDomainMs(pages);
    const widestOther = Math.max(...pages.filter((p) => p.page !== 8).map((p) => p.ms));
    expect(widestOther / domain).toBeGreaterThanOrEqual(0.4);
    expect(domain).toBe(78_000);
  });

  it("facts: longest pages by time, the most-above-typical page, and page 1 dropped when it spans visits", () => {
    const base = personResponseF1;
    const pg = (page: number, ms: number, shortLabel: string | null, typicalMs: number | null = null, ratio: number | null = null) => ({
      ...base.pages[0],
      page,
      ms,
      shortLabel,
      label: shortLabel,
      typicalMs,
      ratio,
      readCount: 8,
      state: "read" as const,
    });
    const pages = [
      pg(1, 60_000, "Cover", 40_000, 1.5),
      pg(8, 44_000, "Pricing", 7_800, 5.6),
      pg(10, 47_000, "Financials", 20_000, 2.3),
      pg(12, 39_000, "Appendix", 30_000, 1.3),
      pg(5, 19_000, null, 4_700, 4),
    ];
    const stop = (page: number, ms: number) => ({ page, ms, revisit: false, passed: false, untimed: false });
    const visitA = { ...base.visits[0], visitId: "a", stops: [stop(1, 30_000), stop(10, 47_000)] };
    const visitB = { ...base.visits[0], visitId: "b", stops: [stop(1, 30_000), stop(8, 44_000), stop(12, 39_000)] };
    // Cover time adds up over two visits, so it is left out; the top ratio (page 8) is already a longest page.
    expect(longestPagesText(pages, [visitA, visitB])).toBe("Page 10 · Financials 47s, Page 8 · Pricing 44s");
    expect(aboveTypicalRow(pages, [visitA, visitB], null)).toBeNull();
    // One visit: the cover counts and leads Longest pages, leaving page 8 as Above typical.
    const single = { ...visitB, stops: [stop(1, 60_000), ...visitB.stops.slice(1)] };
    expect(longestPagesText(pages, [single])).toBe("Page 1 · Cover 1m, Page 10 · Financials 47s");
    expect(aboveTypicalText(aboveTypicalRow(pages, [single], null)!)).toBe("Page 8 · Pricing — 5.6× (44s vs 7.8s typical)");
    expect(aboveTypicalRow(pages, [single], 8)).toBeNull();
    const now = Date.parse(base.person.lastSeen) + 2 * 3_600_000;
    const html = render({ ...base, pages, visits: [single], facts: { ...base.facts, visits: 1, maxPage: 12 }, verdict: { ...base.verdict, page: null } }, now);
    expect(html).toContain(">Longest pages<");
    expect(html).toContain(">Above typical<");
    expect(html).toContain(">Opened<");
    expect(html).toContain(">2 h ago<");
    expect(html).not.toMatch(/<dt[^>]*>Visits</);
    expect(html).not.toContain(">First seen<");
  });

  it("header: a dwell chip about the verdict's page is hidden, Copy link names its link, Left on is short", () => {
    const base = personResponsePT1A;
    const data: PersonResponse = {
      ...base,
      person: {
        ...base.person,
        activeNow: false,
        linkLabel: "Sequoia",
        hot: { kind: "dwell", page: 2, ms: 30_000, ratio: 6, pageTypicalMs: null, pageRatio: null, docTypicalMs: 5_000 },
      },
      pages: base.pages.map((p) =>
        p.page === 4 ? { ...p, label: "Cover series a deck lumen health", shortLabel: "Cover" } : p,
      ),
    };
    const html = render(data);
    expect(base.verdict.page).toBe(2);
    expect(count(html, /data-reader-chip/g)).toBe(0);
    expect(render({ ...data, verdict: { ...data.verdict, page: 3 } })).toContain("data-reader-chip");
    expect(html).toContain('aria-label="Copy the Sequoia link"');
    expect(html).toContain(">Copy link<");
    expect(html).toContain(">Page 4 · Cover<");
    expect(html).toContain('title="Page 4 · Cover series a deck lumen health"');
  });

  describe("Stayed on fact, value column, chip and ribbon", () => {
    const base = personResponseF1;
    const pageRow = (page: number, state: PersonPageRow["state"], ms = 0): PersonPageRow => ({
      ...base.pages[0],
      page,
      state,
      ms,
      label: null,
      shortLabel: null,
      typicalMs: null,
      ratio: null,
      revisits: 0,
      leftHere: false,
    });
    const twelve = (stateOf: (page: number) => PersonPageRow["state"]) =>
      Array.from({ length: 12 }, (_, i) => pageRow(i + 1, stateOf(i + 1), stateOf(i + 1) === "read" ? 20_000 : 0));

    it("reader-21 shape: stayed on 8 of 12 with jumped past and under 2s spelled out, adding up to 12", () => {
      const pages = twelve((p) => (p >= 7 && p <= 9 ? "jumped" : p === 12 ? "passed" : "read"));
      expect(stayedOnFact(pages, 12)).toEqual({ value: "8 of 12", sub: "3 jumped past · 1 under 2s" });
      const html = render({
        ...base,
        pageCount: 12,
        pages,
        facts: { ...base.facts, visits: 2, maxPage: 12, reachedCount: 9, exitPage: 12 },
      });
      expect(html).toContain(">Stayed on<");
      expect(html).toContain(">8 of 12<");
      expect(html).toContain(">3 jumped past · 1 under 2s<");
      expect(html).not.toContain(">Pages reached<");
      expect(count(html, />Jumped past</g)).toBe(3);
    });

    it("Nadia shape: 11 of 12 matches the chip, and the unrecorded page is named", () => {
      const pages = twelve((p) => (p === 12 ? "unknown" : "read"));
      expect(stayedOnFact(pages, 12)).toEqual({ value: "11 of 12", sub: "1 time not recorded" });
      expect(stayedOnFact(twelve((p) => (p >= 11 ? "unknown" : "read")), 12).sub).toBe("2 times not recorded");
      expect(stayedOnFact(twelve(() => "read"), 12)).toEqual({ value: "12 of 12", sub: null });
      const html = render({ ...base, pageCount: 12, pages, facts: { ...base.facts, visits: 2, maxPage: 12, reachedCount: 12, exitPage: 12 } });
      expect(html).toContain(">11 of 12<");
      expect(html).toContain(">1 time not recorded<");
    });

    it("Longest pages drops a trivial second page", () => {
      const read = (page: number, ms: number) => ({ ...pageRow(page, "read"), ms });
      expect(longestPages([read(6, 93_000), read(1, 5_000)], []).map((p) => p.page)).toEqual([6]);
      // 10s or more but under a quarter of the first: still dropped.
      expect(longestPages([read(6, 93_000), read(2, 20_000)], []).map((p) => p.page)).toEqual([6]);
      expect(longestPages([read(6, 40_000), read(2, 10_000)], []).map((p) => p.page)).toEqual([6, 2]);
      const html = render({ ...base, pages: [read(1, 93_000), read(2, 5_000), read(3, 0), read(4, 0)] });
      expect(html).toContain(">Longest page<");
    });

    it("every row reserves the widest value sub-line so the value column is shared and never spills", () => {
      const read = (page: number, typicalMs: number | null, ratio: number | null) => ({ ...pageRow(page, "read", 30_000), typicalMs, ratio });
      const pages = [read(1, 7_700, 15.3), read(2, 7_700, 1.1), read(3, null, null)];
      expect(valueSubLineChars(pages)).toBe("typical 7.7s · 15.3×".length);
      const html = render({ ...base, pages });
      expect(count(html, /grid-cols-\[56px_minmax\(0,1fr\)_auto\] /g)).toBe(3);
      expect(html).toContain("sm:grid-cols-[56px_12rem_minmax(0,1fr)_auto]");
      expect(count(html, /min-width:20ch/g)).toBe(3);
      expect(count(html, /min-w-\[4\.5rem\] self-start text-right/g)).toBe(3);
    });

    it("header hides a Came back chip when the verdict's behaviour opens with it", () => {
      const person = {
        ...base.person,
        activeNow: false,
        hot: { kind: "returned" as const, gapMs: 2 * 86_400_000, fromAt: "2026-09-10T15:00:00.000Z", toAt: "2026-09-12T15:00:00.000Z" },
      };
      const chip = render({ ...base, person, verdict: { ...base.verdict, page: null, behaviour: "Went back to page 3" } });
      const chipText = chip.match(/data-reader-chip[^>]*><span[^>]*><\/span>([^<]*)</);
      expect(chipText?.[1]).toMatch(/^Came back /);
      const behaviour = `${chipText?.[1]} and spent 47s on page 10`;
      const hidden = render({ ...base, person, verdict: { ...base.verdict, page: null, behaviour } });
      expect(count(hidden, /data-reader-chip/g)).toBe(0);
    });

    it("ribbon: timed stops floor at 6px and every non-untimed stop gets a hit area below its neighbours", () => {
      const visit = {
        ...base.visits[0],
        exitPage: 3,
        passedPages: [2],
        stops: [
          { page: 1, ms: 4_000, revisit: false, passed: false, untimed: false },
          { page: 2, ms: 0, revisit: false, passed: true, untimed: false },
          { page: 3, ms: 11_000, revisit: true, passed: false, untimed: false },
          { page: 4, ms: 0, revisit: false, passed: false, untimed: true },
        ],
      };
      const html = render({ ...base, visits: [visit] });
      const buttons = html.match(/<button[^>]*aria-label="Page \d[^"]*"[^>]*>/g) ?? [];
      expect(buttons).toHaveLength(4);
      expect(buttons.filter((b) => b.includes("before:-inset-x-2") && b.includes("before:-z-10"))).toHaveLength(3);
      expect(buttons[3]).not.toContain("before:");
      expect(buttons.every((b) => !b.includes("@container") && !b.includes("opacity"))).toBe(true);
      expect(html).toContain("isolate flex max-w-full flex-wrap");
      // 2 timed × 6px + 8px under 2s + 16px untimed + 3 × 2px gaps.
      expect(html).toContain("--ribbon-min:42px");
    });
  });
});
