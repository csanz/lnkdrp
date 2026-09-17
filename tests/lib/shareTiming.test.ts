/**
 * The two time counters a stats heartbeat feeds (`src/lib/analytics/shareTiming.ts`).
 *
 * The scenario below is a real one, reproduced from a live read that a peer session captured: three
 * pages at 7.962s, 5.616s and 6.741s, a 30s heartbeat that never fired, and a close flush. The
 * stored figures were 20.282s against page 3 and a document total 26% above the real elapsed time.
 * These tests replay the exact sequence of payloads the viewer now sends and assert the totals come
 * back equal to the wall clock.
 */
import { describe, expect, test } from "vitest";

import {
  countsAsPageRevisit,
  FLUSH_REASONS,
  isPageExit,
  pageTimeIncrement,
  parseFlushReason,
  parsePageBound,
  parseTimingVersion,
  visitTimeIncrement,
} from "@/lib/analytics/shareTiming";

/** Accumulate a sequence of heartbeats the way the ingest route does. */
function accumulate(payloads: Array<{ pageNumber?: number | null } & Parameters<typeof visitTimeIncrement>[0]>) {
  let timeSpentMs = 0;
  const pageTimeMsByPage: Record<string, number> = {};
  for (const p of payloads) {
    const visit = visitTimeIncrement(p);
    if (visit) timeSpentMs += visit;
    if (p.pageNumber) {
      const page = pageTimeIncrement(p);
      if (page) pageTimeMsByPage[String(p.pageNumber)] = (pageTimeMsByPage[String(p.pageNumber)] ?? 0) + page;
    }
  }
  return { timeSpentMs, pageTimeMsByPage };
}

const NONE = { durationMs: null, pageDurationMs: null, enteredAtMs: null, leftAtMs: null };

describe("a three-page read, flushed at close", () => {
  // Page 1 for 7962ms, page 2 for 5616ms, page 3 for 6741ms. Two page turns, then the close flush.
  const t0 = 1_760_000_000_000;
  const t1 = t0 + 7962;
  const t2 = t1 + 5616;
  const t3 = t2 + 6741;

  const payloads = [
    // Page turn 1 -> 2: the page clock only.
    { ...NONE, pageNumber: 1, pageDurationMs: 7962, enteredAtMs: t0, leftAtMs: t1 },
    // Page turn 2 -> 3.
    { ...NONE, pageNumber: 2, pageDurationMs: 5616, enteredAtMs: t1, leftAtMs: t2 },
    // Close: the visit chunk since the visit started, plus page 3's own segment.
    { pageNumber: 3, durationMs: t3 - t0, pageDurationMs: 6741, enteredAtMs: t2, leftAtMs: t3 },
  ];

  test("each page holds its own time, not the visit's", () => {
    const { pageTimeMsByPage } = accumulate(payloads);
    // The bug stored 20282 against page 3: its own 6741 plus the whole 13578ms visit chunk.
    expect(pageTimeMsByPage).toEqual({ "1": 7962, "2": 5616, "3": 6741 });
  });

  test("the document total equals the elapsed time, not 126% of it", () => {
    const { timeSpentMs } = accumulate(payloads);
    expect(timeSpentMs).toBe(t3 - t0);
    // The page times sum to the same wall clock, from the other direction.
    const { pageTimeMsByPage } = accumulate(payloads);
    expect(Object.values(pageTimeMsByPage).reduce((a, b) => a + b, 0)).toBe(t3 - t0);
  });
});

describe("visitTimeIncrement", () => {
  test("takes only the visit clock, never the page segment", () => {
    // A page-turn POST carries no `durationMs`. If this fell back to the page segment, every page
    // turn would add to the document total seconds the heartbeat is already counting.
    expect(visitTimeIncrement({ ...NONE, pageDurationMs: 9000, enteredAtMs: 1, leftAtMs: 9001 })).toBeNull();
    expect(visitTimeIncrement({ ...NONE, durationMs: 4200 })).toBe(4200);
  });

  test("ignores non-positive and non-finite values", () => {
    expect(visitTimeIncrement({ ...NONE, durationMs: 0 })).toBeNull();
    expect(visitTimeIncrement({ ...NONE, durationMs: -5 })).toBeNull();
    expect(visitTimeIncrement({ ...NONE, durationMs: Number.NaN })).toBeNull();
  });

  test("caps a single report at one day", () => {
    expect(visitTimeIncrement({ ...NONE, durationMs: 10 * 24 * 60 * 60 * 1000 })).toBe(24 * 60 * 60 * 1000);
  });
});

describe("pageTimeIncrement", () => {
  test("prefers the page clock", () => {
    expect(pageTimeIncrement({ durationMs: 99999, pageDurationMs: 3000, enteredAtMs: 1, leftAtMs: 50000 })).toBe(3000);
  });

  test("falls back to the reported interval when the page clock is absent", () => {
    expect(pageTimeIncrement({ ...NONE, enteredAtMs: 1_000, leftAtMs: 4_000 })).toBe(3000);
  });

  test("never falls back to durationMs — that fallback was the double count", () => {
    // A heartbeat carrying a page number and a visit chunk would otherwise credit visit time to the
    // page, which is the original bug wearing a compatibility label.
    expect(pageTimeIncrement({ ...NONE, durationMs: 2500 })).toBeNull();
    expect(pageTimeIncrement(NONE)).toBeNull();
  });

  test("ignores an interval that runs backwards", () => {
    expect(pageTimeIncrement({ ...NONE, enteredAtMs: 9_000, leftAtMs: 1_000 })).toBeNull();
  });
});

describe("isPageExit", () => {
  test("a heartbeat is not an exit, so it cannot manufacture a revisit", () => {
    // The 30s heartbeat reports the visit clock and the page clock but no interval. It used to send
    // one, and a single 25-second stay on page 2 arrived as two segments — the visit detail showed
    // a reader coming back to a page they had never left.
    expect(isPageExit({ durationMs: 30000, pageDurationMs: 25000, enteredAtMs: null, leftAtMs: null })).toBe(false);
  });

  test("a page turn or a close carries the interval and is an exit", () => {
    expect(isPageExit({ durationMs: null, pageDurationMs: 7962, enteredAtMs: 1000, leftAtMs: 8962 })).toBe(true);
  });

  test("an interval that does not advance is not an exit", () => {
    expect(isPageExit({ durationMs: null, pageDurationMs: null, enteredAtMs: 5000, leftAtMs: 5000 })).toBe(false);
    expect(isPageExit({ durationMs: null, pageDurationMs: null, enteredAtMs: 9000, leftAtMs: 1000 })).toBe(false);
  });
});

describe("a long stay on one page, flushed by heartbeats", () => {
  test("accrues time once and produces exactly one segment", () => {
    const t0 = 1_760_000_000_000;
    const payloads = [
      // Two heartbeats during a 70-second stay on page 2. The viewer sends no page number on a
      // heartbeat, so these move the visit total and touch no page at all.
      { durationMs: 30000, pageDurationMs: null, enteredAtMs: null, leftAtMs: null },
      { durationMs: 30000, pageDurationMs: null, enteredAtMs: null, leftAtMs: null },
      // The close: the page's whole 70-second segment, and the last 10s of the visit clock.
      { pageNumber: 2, durationMs: 10000, pageDurationMs: 70000, enteredAtMs: t0, leftAtMs: t0 + 70000 },
    ];
    const segments = payloads.filter((p) => isPageExit(p));
    expect(segments).toHaveLength(1);
    expect(payloads.reduce((a, p) => a + (visitTimeIncrement(p) ?? 0), 0)).toBe(70000);
    // Page time comes only from the exit: the heartbeats carry no page clock, so nothing is
    // credited twice even though all three payloads name page 2.
    expect(payloads.reduce((a, p) => a + (pageTimeIncrement(p) ?? 0), 0)).toBe(70000);
  });
});

describe("wire parsers for the reading clock", () => {
  test("parseTimingVersion accepts integers 1..9 only", () => {
    expect(parseTimingVersion(1)).toBe(1);
    expect(parseTimingVersion(2)).toBe(2);
    expect(parseTimingVersion(9)).toBe(9);
    expect(parseTimingVersion(0)).toBeNull();
    expect(parseTimingVersion(10)).toBeNull();
    expect(parseTimingVersion(-2)).toBeNull();
    expect(parseTimingVersion(2.5)).toBeNull();
    expect(parseTimingVersion(Number.NaN)).toBeNull();
    expect(parseTimingVersion("2")).toBeNull();
    expect(parseTimingVersion(null)).toBeNull();
    expect(parseTimingVersion(undefined)).toBeNull();
  });

  test("parsePageBound accepts integers 1..5000 only", () => {
    expect(parsePageBound(1)).toBe(1);
    expect(parsePageBound(5000)).toBe(5000);
    expect(parsePageBound(0)).toBeNull();
    expect(parsePageBound(5001)).toBeNull();
    expect(parsePageBound(3.2)).toBeNull();
    expect(parsePageBound(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parsePageBound("4")).toBeNull();
    expect(parsePageBound({})).toBeNull();
  });

  test("parseFlushReason accepts the six reasons only", () => {
    for (const r of FLUSH_REASONS) expect(parseFlushReason(r)).toBe(r);
    expect(FLUSH_REASONS).toEqual(["turn", "hidden", "pagehide", "unmount", "heartbeat", "idle"]);
    expect(parseFlushReason("TURN")).toBeNull();
    expect(parseFlushReason(" turn")).toBeNull();
    expect(parseFlushReason("close")).toBeNull();
    expect(parseFlushReason(1)).toBeNull();
    expect(parseFlushReason(null)).toBeNull();
  });

  test("countsAsPageRevisit: hidden and idle splits are not revisits", () => {
    expect(countsAsPageRevisit("turn")).toBe(true);
    expect(countsAsPageRevisit("pagehide")).toBe(true);
    expect(countsAsPageRevisit("unmount")).toBe(true);
    expect(countsAsPageRevisit("heartbeat")).toBe(true);
    expect(countsAsPageRevisit("hidden")).toBe(false);
    expect(countsAsPageRevisit("idle")).toBe(false);
    expect(countsAsPageRevisit(null)).toBe(true);
  });
});
