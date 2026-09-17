import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ReaderSheetBody from "@/components/metrics/reader/ReaderSheetBody";
import type { PersonResponse } from "@/lib/analytics/reading/types";
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
    expect(verdictText(html)).toBe("Went through all 4 pages. Went back to page 3.");
    expect(html).toContain("Stayed on 4 of 4 pages");
    expect(html).toContain("Page 3");
    expect(count(html, /data-reader-page=/g)).toBe(4);
    expect(html).toContain("left on page 3");
    expect(count(html, /data-typical-tick/g)).toBe(0);
    expect(html).not.toContain("typical time for people who stayed");
    expect(html).toContain("↺ went back");
    expect(html).toContain("Left here");
    expect(html).toContain("data-ribbon");
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain("Anonymous · via Default link");
    expectNoForbiddenCopy(html);
  });

  it("F6: newest visit first with a came-back divider and last-page ending", () => {
    const html = render(personResponseF6);
    expect(html).toContain("came back 2 days later");
    expect(html).toContain("ended on the last page");
    expect(html).toContain("Passed: page 1");
    expect(html.indexOf("5 → 6")).toBeLessThan(html.indexOf("1 → 2 · left on page 2"));
    expect(count(html, /data-reader-page=/g)).toBe(6);
    expect(html).toContain("Not reached");
    expectNoForbiddenCopy(html);
  });

  it("PT1-A: typical ticks only on pages with a typical time, plus the legend", () => {
    const html = render(personResponsePT1A);
    expect(personResponsePT1A.pages.filter((p) => p.typicalMs !== null).map((p) => p.page)).toEqual([1, 2]);
    expect(count(html, /data-typical-tick/g)).toBe(2);
    expect(html).toContain("typical time for people who stayed on this page for 2s or more (shown once 3 have)");
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
    expect(html).toContain("Seen · time not recorded");
    expect(html).toContain("dana@example.test · entered by the reader, not verified · via Default link");
    expect(html).toContain("Active in the last 10 minutes");
    expect(html).not.toContain("Stayed on 4 of 4 pages");
    expect(html).toContain("Copy email");
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
});
