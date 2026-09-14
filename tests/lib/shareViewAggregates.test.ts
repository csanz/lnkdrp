/**
 * The analytics aggregation building blocks (`src/lib/analytics/shareViewAggregates.ts`).
 *
 * These are pinned by tests because each one failed *silently* in production shape: a bad Mongo
 * reference yields `null`, the route's defensive `?? {}` turns that into an empty object, and the
 * metrics UI renders a blank chip forever with no error anywhere. Nothing here needs a database —
 * the point is the shape of the expression and the arithmetic it is supposed to perform.
 */
import { describe, expect, test } from "vitest";

import {
  LAST_ACTIVITY_EXPR,
  LINK_VIEWER_KEY_EXPR,
  mergePageTimeMaps,
  pageTimeMergeExpr,
  windowStartUtc,
} from "@/lib/analytics/shareViewAggregates";

/** Every `"$field"` string anywhere inside an aggregation expression. */
function fieldRefs(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof node === "string") {
    if (node.startsWith("$") && !node.startsWith("$$")) out.add(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const v of node) fieldRefs(v, out);
    return out;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      // Operator keys ($map, $reduce, …) are not field paths; their values may be.
      if (!k.startsWith("$")) fieldRefs(k, out);
      fieldRefs(v, out);
    }
  }
  return out;
}

describe("pageTimeMergeExpr", () => {
  test("reads only the named $group output — never a sibling alias of the same $project", () => {
    const expr = pageTimeMergeExpr("pageTimeMaps");
    const refs = fieldRefs(expr);
    expect([...refs]).toEqual(["$pageTimeMaps"]);
    // The regression: `pageTimeItemsArrays` was computed in the same `$project` that consumed it,
    // so the `$reduce` input resolved to missing and every viewer's map came back `{}`.
    expect([...refs]).not.toContain("$pageTimeItemsArrays");
  });

  test("does the $objectToArray inside the $let, so the merge is a single stage", () => {
    const expr = pageTimeMergeExpr("pageTimeMaps") as any;
    const input = expr.$let.vars.allItems.$reduce.input;
    expect(input.$map.in).toHaveProperty("$objectToArray");
    expect(input.$map.input).toEqual({ $ifNull: ["$pageTimeMaps", []] });
  });

  test("refuses a field name that is already a path, which would double the $", () => {
    expect(() => pageTimeMergeExpr("$pageTimeMaps")).toThrow();
    expect(() => pageTimeMergeExpr("")).toThrow();
  });
});

describe("mergePageTimeMaps", () => {
  test("sums per-page milliseconds across a viewer's rows", () => {
    // One browser, two links: {1: 4000, 2: 5000} through link A and {7: 9000} through link B.
    expect(mergePageTimeMaps([{ "1": 4000, "2": 5000 }, { "7": 9000 }])).toEqual({
      "1": 4000,
      "2": 5000,
      "7": 9000,
    });
  });

  test("adds the same page seen through two links instead of overwriting it", () => {
    expect(mergePageTimeMaps([{ "1": 4000 }, { "1": 250 }])).toEqual({ "1": 4250 });
  });

  test("survives empty, missing and non-numeric entries", () => {
    expect(mergePageTimeMaps([])).toEqual({});
    expect(mergePageTimeMaps([null, undefined, {}])).toEqual({});
    expect(mergePageTimeMaps([{ "1": "nope" as unknown as number }, { "1": 10 }])).toEqual({ "1": 10 });
  });
});

describe("LAST_ACTIVITY_EXPR", () => {
  test("prefers lastViewedAt and only falls back to updatedDate", () => {
    // `updatedDate` alone is wrong: Mongoose stamps it on every update query, so a backfill (or
    // the metrics route's own viewer-name repair) rewrote the whole "Last viewed" column to the
    // instant the maintenance ran.
    expect(LAST_ACTIVITY_EXPR).toEqual({ $ifNull: ["$lastViewedAt", "$updatedDate"] });
  });
});

describe("LINK_VIEWER_KEY_EXPR", () => {
  test("buckets per (link, viewer), so the document figure is the sum over links", () => {
    expect(LINK_VIEWER_KEY_EXPR.shareId).toBe("$shareId");
    const refs = fieldRefs(LINK_VIEWER_KEY_EXPR);
    expect(refs.has("$shareId")).toBe(true);
    expect(refs.has("$viewerUserId")).toBe(true);
    expect(refs.has("$botIdHash")).toBe(true);
  });

  test("keeps signed-in and anonymous identities in separate namespaces", () => {
    const cond = (LINK_VIEWER_KEY_EXPR.viewer as any).$cond;
    expect(cond[1].$concat[0]).toBe("u:");
    expect(cond[2].$concat[0]).toBe("a:");
  });
});

describe("windowStartUtc", () => {
  test("is the start of the UTC day, days-1 days back (inclusive bound)", () => {
    const now = new Date("2026-09-13T22:41:00.000Z");
    expect(windowStartUtc(7, now).toISOString()).toBe("2026-09-07T00:00:00.000Z");
    expect(windowStartUtc(1, now).toISOString()).toBe("2026-09-13T00:00:00.000Z");
    expect(windowStartUtc(15, now).toISOString()).toBe("2026-08-30T00:00:00.000Z");
  });

  test("never returns a window shorter than one day", () => {
    const now = new Date("2026-09-13T22:41:00.000Z");
    expect(windowStartUtc(0, now).toISOString()).toBe("2026-09-13T00:00:00.000Z");
  });
});
