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

import { pageTimeIncrement, visitTimeIncrement } from "@/lib/analytics/shareTiming";

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

  test("falls back last to durationMs, for tabs running the old build", () => {
    // Over-counts exactly as that build always did, which beats dropping the page time of every
    // tab open on the day this ships.
    expect(pageTimeIncrement({ ...NONE, durationMs: 2500 })).toBe(2500);
    expect(pageTimeIncrement(NONE)).toBeNull();
  });

  test("ignores an interval that runs backwards", () => {
    expect(pageTimeIncrement({ ...NONE, enteredAtMs: 9_000, leftAtMs: 1_000 })).toBeNull();
  });
});
