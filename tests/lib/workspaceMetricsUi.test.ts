/**
 * The wording and tone rules behind the `/metrics` page
 * (`src/components/workspaceMetrics/format.ts`).
 *
 * These are the sentences a reader actually judges the product by — "+18% vs previous 30 days",
 * "New", "12 of 31 shared" — and the cases that go wrong are the boring ones: a previous period of
 * zero, a singular noun, a link with no label. They are pure functions so they can be pinned here
 * instead of being checked by eye on a screenshot.
 */
import { describe, expect, it } from "vitest";

import {
  METRIC_KEYS,
  changeChip,
  visibleMetricKeys,
  formatMetricCompact,
  formatMetricPoint,
  formatMetricValue,
  isDurationMetric,
  linkDisplayName,
  openedSentence,
  outputSentence,
  peopleCountSentence,
  seriesValues,
} from "@/components/workspaceMetrics/format";

const delta = (value: number, previous: number | null, changePct: number | null) => ({ value, previous, changePct });

describe("changeChip", () => {
  it("is nothing at all when no previous period was served", () => {
    // Free gets `previous: null`; a tile must then say nothing, not "0%".
    expect(changeChip(delta(231, null, null), 0, "Views")).toBeNull();
    expect(changeChip(delta(231, null, null), 7, "Views")).toBeNull();
  });

  it("says New when the previous period was empty, and nothing when both are empty", () => {
    const chip = changeChip(delta(583, 0, null), 30, "Views");
    expect(chip?.tone).toBe("new");
    expect(chip?.label).toBe("New");
    expect(changeChip(delta(0, 0, null), 30, "Views")).toBeNull();
  });

  it("signs the percentage and picks a non-alarming tone for a fall", () => {
    const up = changeChip(delta(118, 100, 18), 30, "Views");
    expect(up).toMatchObject({ tone: "up", label: "+18%", caption: "vs previous 30 days" });
    const down = changeChip(delta(82, 100, -18), 30, "Views");
    expect(down?.tone).toBe("down");
    expect(down?.label).toBe("-18%");
    expect(changeChip(delta(100, 100, 0), 30, "Views")?.tone).toBe("flat");
  });

  it("keeps a decimal only where it says something", () => {
    expect(changeChip(delta(1, 1, 18.5), 7, "Views")?.label).toBe("+18.5%");
    expect(changeChip(delta(1, 1, 18), 7, "Views")?.label).toBe("+18%");
  });

  it("names the metric and the previous total in the hover title", () => {
    expect(changeChip(delta(118, 100, 18), 30, "Downloads")?.title).toBe(
      "Downloads +18% against the previous 30 days (100)",
    );
  });
});

describe("metric formatting", () => {
  it("treats reading time as a duration and everything else as a count", () => {
    expect(METRIC_KEYS.filter(isDurationMetric)).toEqual(["readingTimeMs"]);
    expect(formatMetricValue("views", 1234)).toBe("1,234");
    expect(formatMetricValue("readingTimeMs", 99_000)).toBe("1m 39s");
    expect(formatMetricCompact("views", 1234)).toBe("1,234");
  });

  it("keeps the minutes in a chart label above an hour, so two peaks cannot share a number", () => {
    // `formatDwellCompact` floors to one unit, so 1h00m and 1h59m both printed "1h" and two
    // visibly different peaks carried the same count label.
    expect(formatMetricCompact("readingTimeMs", 4_356_424)).toBe("1h 12m");
    expect(formatMetricCompact("readingTimeMs", 4_827_932)).toBe("1h 20m");
    expect(formatMetricCompact("readingTimeMs", 99_000)).toBe("1m 39s");
  });

  it("offers four tiles, or three when opens is a floor rather than a count", () => {
    expect(METRIC_KEYS).toEqual(["views", "opens", "readingTimeMs", "downloads"]);
    expect(visibleMetricKeys(false)).toEqual(["views", "opens", "readingTimeMs", "downloads"]);
    expect(visibleMetricKeys(true)).toEqual(["views", "readingTimeMs", "downloads"]);
  });

  it("spells one chart point with the right noun", () => {
    expect(formatMetricPoint("views", 1)).toBe("1 view");
    expect(formatMetricPoint("views", 12)).toBe("12 views");
    expect(formatMetricPoint("downloads", 1)).toBe("1 download");
    expect(formatMetricPoint("readingTimeMs", 99_000)).toBe("1m 39s");
  });

  it("pulls a series and floors anything that is not a usable number", () => {
    const series = [
      { day: "2026-09-01", views: 3, opens: 4, readingTimeMs: 1000, downloads: 0 },
      { day: "2026-09-02", views: -1, opens: 0, readingTimeMs: Number.NaN, downloads: 1 },
    ];
    expect(seriesValues(series, "views")).toEqual([3, 0]);
    expect(seriesValues(series, "readingTimeMs")).toEqual([1000, 0]);
  });
});

describe("sentences", () => {
  it("counts documents opened against documents shared", () => {
    expect(openedSentence({ opened: 12, shared: 31, openedOther: 0, returningReaders: 4 })).toBe(
      "12 of 31 shared documents were opened · 4 readers came back",
    );
    expect(openedSentence({ opened: 0, shared: 0, openedOther: 0, returningReaders: 0 })).toBe(
      "0 of 0 shared documents were opened",
    );
    expect(openedSentence({ opened: 1, shared: 1, openedOther: 0, returningReaders: 1 })).toBe(
      "1 of 1 shared document was opened · 1 reader came back",
    );
  });

  it("names the documents that were read but are outside the shared denominator", () => {
    // The headline and the ranked list include archived documents; the count must not be quietly
    // shorter than the list under it.
    expect(openedSentence({ opened: 51, shared: 104, openedOther: 1, returningReaders: 123 })).toBe(
      "51 of 104 shared documents were opened (plus 1 archived or unshared) · 123 readers came back",
    );
  });

  it("drops the returns clause when opens is known to be missing rows", () => {
    expect(openedSentence({ opened: 51, shared: 104, openedOther: 0, returningReaders: null })).toBe(
      "51 of 104 shared documents were opened",
    );
  });

  it("spells the workspace output line, singular and plural", () => {
    expect(outputSentence(30, { docsShared: 4, linksCreated: 9, uploads: 6 })).toBe(
      "In the last 30 days: 4 documents got their first link · 9 links created · 6 uploads",
    );
    expect(outputSentence(7, { docsShared: 1, linksCreated: 1, uploads: 1 })).toBe(
      "In the last 7 days: 1 document got its first link · 1 link created · 1 upload",
    );
  });

  it("never calls the output count 'documents shared', which the page uses for a narrower set", () => {
    // `output.docsShared` counts every live document that got a first link in the window (124 on the
    // seed workspace); `docsOpened.shared` counts the ones being shared now (104). Both clauses said
    // "shared" four lines apart, and 124 over 104 reads as a bug rather than as two questions.
    const line = outputSentence(30, { docsShared: 124, linksCreated: 521, uploads: 151 });
    expect(line).toBe("In the last 30 days: 124 documents got their first link · 521 links created · 151 uploads");
    expect(line).not.toContain("documents shared");
    expect(openedSentence({ opened: 51, shared: 104, openedOther: 1, returningReaders: 72 })).toContain(
      "of 104 shared documents",
    );
  });

  it("gives Free a count of people and never a name", () => {
    expect(peopleCountSentence(1)).toBe("1 person viewed your documents in this period");
    expect(peopleCountSentence(169)).toBe("169 people viewed your documents in this period");
  });
});

describe("linkDisplayName", () => {
  it("prefers the label, falls back to the audience, then to what kind of link it is", () => {
    expect(linkDisplayName({ label: "Cyberdyne CISO office", audience: "security", isDefault: false })).toBe("Cyberdyne CISO office");
    expect(linkDisplayName({ label: "   ", audience: "Cyberdyne security leadership", isDefault: false })).toBe(
      "Cyberdyne security leadership",
    );
    expect(linkDisplayName({ label: "", audience: null, isDefault: true })).toBe("Default link");
    expect(linkDisplayName({ label: "", audience: "  ", isDefault: false })).toBe("Untitled link");
  });
});
