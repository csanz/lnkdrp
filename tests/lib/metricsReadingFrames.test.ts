/**
 * The metrics pages have to move while somebody is reading, not only when they arrive.
 *
 * The realtime server splits a reader into two frames (`realtime/server.ts`): `viewer` on the
 * `shareviews` insert and on a `viewerName` / `viewerEmailSnapshot` write, `reading` on every
 * other progress write. An arrival happens once per (link, reader) and a name only when someone
 * re-answers "introduce yourself", so everything else a reading produces — the visit clock, the
 * page clock, pages seen, a repeat open — arrives as `reading` and nothing else.
 *
 * `MetricsView` subscribed to `hello` and `viewer` and to no third thing, and its only other
 * refresh path opened with "socket is open, nothing to do". Those two facts together are the bug:
 * a healthy channel carrying frames this page did not listen for left the page with no refresh
 * path at all for the length of a reading session, while a dead channel would have picked the same
 * numbers up within thirty seconds. Realtime working made the page staler than realtime missing.
 *
 * Three things are pinned here:
 *
 * 1. The scope filter for a progress frame, which has to match the identity one: a document page
 *    can compare documents, a project page cannot (a `ShareView` carries no project).
 * 2. The fallback rule, which is now a floor rather than an either/or.
 * 3. That the component still wires both of them up. The bug was never a wrong function, it was a
 *    subscription that was never added, so the source check is the part that holds the line.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  METRICS_STALE_FLOOR_MS,
  readingFrameInScope,
  shouldFallbackRefetch,
} from "@/components/metrics/MetricsView";

const REPO_ROOT = path.resolve(__dirname, "../..");
const VIEW_SRC = fs.readFileSync(
  path.join(REPO_ROOT, "src/components/metrics/MetricsView.tsx"),
  "utf8",
);
const SERVER_SRC = fs.readFileSync(
  path.join(REPO_ROOT, "realtime/server.ts"),
  "utf8",
);

const DOC = "6512c0ffee00000000000002";
const OTHER_DOC = "6512c0ffee00000000000003";

describe("readingFrameInScope", () => {
  test("a document page takes its own document and leaves the rest alone", () => {
    expect(readingFrameInScope({ docId: DOC }, false, DOC)).toBe(true);
    expect(readingFrameInScope({ docId: OTHER_DOC }, false, DOC)).toBe(false);
  });

  test("a frame with no document is taken: a filter it cannot apply must not silence it", () => {
    expect(readingFrameInScope({ docId: null }, false, DOC)).toBe(true);
  });

  test("a project page takes every progress frame, because the frame names no project", () => {
    // `ShareView` has no `projectId` (the link does), so the only honest answer on a project page
    // is to refetch. The server's per-reader throttle and the 400ms debounce are what pay for it.
    expect(readingFrameInScope({ docId: OTHER_DOC }, true, "proj")).toBe(true);
    expect(readingFrameInScope({ docId: null }, true, "proj")).toBe(true);
  });
});

describe("shouldFallbackRefetch", () => {
  test("no socket and a visible tab: the ordinary poll", () => {
    for (const realtime of ["idle", "connecting", "closed", "unavailable"] as const) {
      expect(
        shouldFallbackRefetch({ realtime, visible: true, msSinceLastFetch: 0 }),
      ).toBe(true);
    }
  });

  test("a hidden tab never polls, socket or no socket", () => {
    expect(
      shouldFallbackRefetch({
        realtime: "closed",
        visible: false,
        msSinceLastFetch: 10 * METRICS_STALE_FLOOR_MS,
      }),
    ).toBe(false);
  });

  test("an open socket suppresses the tick only up to the staleness floor", () => {
    // The regression this exists for: while the guard was `realtimeState() === "open"` alone, a
    // page whose events all arrived as a frame type it did not subscribe to never refetched again.
    expect(
      shouldFallbackRefetch({
        realtime: "open",
        visible: true,
        msSinceLastFetch: METRICS_STALE_FLOOR_MS - 1,
      }),
    ).toBe(false);
    expect(
      shouldFallbackRefetch({
        realtime: "open",
        visible: true,
        msSinceLastFetch: METRICS_STALE_FLOOR_MS,
      }),
    ).toBe(true);
  });

  test("the floor is longer than the tick, so a live page pays nothing for it", () => {
    expect(METRICS_STALE_FLOOR_MS).toBeGreaterThan(30_000);
  });
});

describe("MetricsView wiring", () => {
  test("it subscribes to progress frames, filtered by scope", () => {
    expect(VIEW_SRC).toContain('subscribeRealtime("reading"');
    expect(VIEW_SRC).toContain("readingFrameInScope(frame.reading");
    // Still the arrival and the reconnection: the progress frame is a third event, not a swap.
    expect(VIEW_SRC).toContain('subscribeRealtime("viewer"');
    expect(VIEW_SRC).toContain('subscribeRealtime("hello"');
  });

  test("the fallback timer asks the rule instead of trusting an open socket", () => {
    expect(VIEW_SRC).toContain("shouldFallbackRefetch({");
    expect(VIEW_SRC).toContain("msSinceLastFetch: Date.now() - lastFetchAtRef.current");
    expect(VIEW_SRC).not.toContain('if (realtimeState() === "open") return;');
  });

  test("the server still emits progress as its own frame type", () => {
    // If this half is ever folded back into `viewer`, the subscription above becomes dead code
    // rather than a bug, and this test is where that shows up.
    expect(SERVER_SRC).toContain('type: "reading"');
  });
});
