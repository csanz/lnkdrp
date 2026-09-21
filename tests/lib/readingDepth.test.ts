/**
 * The one-word judgement shown beside a reader's name.
 *
 * Pinned because the label is a claim about a person's attention, and the failure mode is not a
 * crash: it is telling someone a recipient "Read" their deck when they had the tab open in the
 * background, or "Glanced" when the clock simply was not running for that visit.
 */
import { describe, expect, test } from "vitest";

import { readingDepth } from "@/lib/metrics/readingDepth";

describe("readingDepth", () => {
  test("no clock is not a verdict", () => {
    expect(readingDepth({ timeMs: 0, pages: 4 })).toBe("unknown");
    expect(readingDepth({ timeMs: null, pages: 9 })).toBe("unknown");
    expect(readingDepth({ timeMs: undefined, pages: undefined })).toBe("unknown");
  });

  test("a few seconds is a glance, whatever it touched", () => {
    expect(readingDepth({ timeMs: 3_000, pages: 1 })).toBe("glanced");
    // Nine pages in six seconds is someone scrolling to the end, not reading nine pages.
    expect(readingDepth({ timeMs: 6_000, pages: 9 })).toBe("glanced");
  });

  test("a long visit counts as reading only if it was not spread thin", () => {
    // Nine pages in eighty seconds is nine seconds a page: the speed of looking for something.
    expect(readingDepth({ timeMs: 80_000, pages: 9 })).toBe("skimmed");
    // The same eighty seconds over four pages is twenty each, which is reading.
    expect(readingDepth({ timeMs: 80_000, pages: 4 })).toBe("read");
    expect(readingDepth({ timeMs: 240_000, pages: 1 })).toBe("read");
  });

  test("time that only makes sense per page still counts", () => {
    // 20s on each of two pages: under the total threshold, over the per-page one.
    expect(readingDepth({ timeMs: 40_000, pages: 2 })).toBe("read");
  });

  test("pages flicked through in seconds each is a skim", () => {
    expect(readingDepth({ timeMs: 20_000, pages: 9 })).toBe("skimmed");
    expect(readingDepth({ timeMs: 12_000, pages: 4 })).toBe("skimmed");
  });

  test("a single page held for a moment sits between the two", () => {
    expect(readingDepth({ timeMs: 12_000, pages: 1 })).toBe("skimmed");
  });

  test("the same visit is Read on a one-pager and Started on a deck", () => {
    // 31 seconds on one page. On a one-page document that is the whole thing.
    expect(readingDepth({ timeMs: 31_000, pages: 1, totalPages: 1 })).toBe("read");
    // The same 31 seconds on one page of nine is someone who stopped, however attentively.
    expect(readingDepth({ timeMs: 31_000, pages: 1, totalPages: 9 })).toBe("started");
  });

  test("a third of the document is the line", () => {
    expect(readingDepth({ timeMs: 90_000, pages: 3, totalPages: 9 })).toBe("read");
    expect(readingDepth({ timeMs: 60_000, pages: 2, totalPages: 9 })).toBe("started");
  });

  test("an unknown page count never downgrades anyone", () => {
    // Projects have no page denominator; a good read there stays a read.
    expect(readingDepth({ timeMs: 120_000, pages: 2 })).toBe("read");
    expect(readingDepth({ timeMs: 120_000, pages: 2, totalPages: null })).toBe("read");
  });

  test("coverage cannot rescue a skim", () => {
    // Every page, nine seconds each: still a skim, whatever the coverage.
    expect(readingDepth({ timeMs: 80_000, pages: 9, totalPages: 9 })).toBe("skimmed");
  });
});
