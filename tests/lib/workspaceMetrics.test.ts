/**
 * Workspace metrics helpers (docs/prds/lnkdrp-workspace-metrics.md, M1): range resolution and the
 * Free clamp, previous-period windows, deltas, the zero-filled day series, ranking and the quiet
 * document selection — plus the shape of the Mongo fragments, which fail silently when wrong.
 *
 * Expectations are derived from the rules, not copied from live rows.
 */
import { describe, expect, test } from "vitest";

import { FREE_ANALYTICS_DAYS } from "@/lib/billing/planLimits";
import {
  activityBetweenMatch,
  liveShareLinkExpr,
  presenceBetweenMatch,
  VISIT_DAY_KEY_EXPR,
  VISIT_TIME_SUM_EXPR,
  visitBetweenMatch,
  visitWindowMatch,
  workspaceOrgMatch,
  WORKSPACE_NAMED_ROW_MATCH,
  WORKSPACE_PERSON_KEY_EXPR,
  WORKSPACE_VIEWER_KEY_EXPR,
} from "@/lib/analytics/workspace/match";
import {
  avgReadingTimeMs,
  buildSeries,
  changePct,
  delta,
  dayKeysFrom,
  docMetricsHref,
  linkMetricsHref,
  parseWorkspaceRangeKey,
  rankPeople,
  rankTopDocs,
  rankTopLinks,
  resolveWorkspaceRange,
  QUIET_DOC_GRACE_MS,
  selectQuietDocs,
  WORKSPACE_DEFAULT_RANGE,
  workspacePlanInfo,
  type WorkspacePerson,
  type WorkspaceTopDoc,
  type WorkspaceTopLink,
} from "@/lib/analytics/workspace";

/** A fixed "now" inside a day, so the window's UTC-midnight snapping is visible. */
const NOW = new Date("2026-09-17T13:45:00.000Z");

describe("range parsing", () => {
  test("accepts the three keys and defaults to 30 days", () => {
    expect(parseWorkspaceRangeKey("7d")).toBe("7d");
    expect(parseWorkspaceRangeKey("30d")).toBe("30d");
    expect(parseWorkspaceRangeKey("90D")).toBe("90d");
    expect(parseWorkspaceRangeKey(null)).toBe(WORKSPACE_DEFAULT_RANGE);
    expect(parseWorkspaceRangeKey("14d")).toBe("30d");
    expect(parseWorkspaceRangeKey("")).toBe("30d");
  });
});

describe("resolveWorkspaceRange", () => {
  test("Pro 30d: the window starts 29 UTC days back and ends today", () => {
    const r = resolveWorkspaceRange({ requested: "30d", plan: "pro", now: NOW });
    expect(r.range.days).toBe(30);
    expect(r.range.key).toBe("30d");
    expect(r.range.clampedByPlan).toBe(false);
    expect(r.range.start).toBe("2026-08-19");
    expect(r.range.end).toBe("2026-09-17");
    expect(r.dayKeys).toHaveLength(30);
    expect(r.start.toISOString()).toBe("2026-08-19T00:00:00.000Z");
  });

  test("Pro: the previous period is the same length, ending where the current one starts", () => {
    const r = resolveWorkspaceRange({ requested: "30d", plan: "pro", now: NOW });
    expect(r.previousStart?.toISOString()).toBe("2026-07-20T00:00:00.000Z");
    expect(r.previousEnd?.toISOString()).toBe(r.start.toISOString());
    expect(r.range.previous).toEqual({ start: "2026-07-20", end: "2026-08-18" });
  });

  test("Free: 30d is clamped to the plan window and says so, and carries no previous period", () => {
    const r = resolveWorkspaceRange({ requested: "30d", plan: "free", now: NOW });
    expect(r.range.days).toBe(FREE_ANALYTICS_DAYS);
    expect(r.range.key).toBe("7d");
    expect(r.range.requested).toBe("30d");
    expect(r.range.clampedByPlan).toBe(true);
    expect(r.range.start).toBe("2026-09-11");
    expect(r.range.previous).toBeNull();
    expect(r.previousStart).toBeNull();
  });

  test("Free: 7d is served whole and is not reported as clamped", () => {
    const r = resolveWorkspaceRange({ requested: "7d", plan: "free", now: NOW });
    expect(r.range.days).toBe(7);
    expect(r.range.clampedByPlan).toBe(false);
  });

  test("plan info is what the UI locks its range control with", () => {
    expect(workspacePlanInfo("pro")).toEqual({ isPro: true, analyticsDays: null });
    expect(workspacePlanInfo("free")).toEqual({ isPro: false, analyticsDays: FREE_ANALYTICS_DAYS });
  });

  test("day keys run forwards and cross a month boundary", () => {
    expect(dayKeysFrom(new Date("2026-08-30T00:00:00.000Z"), 3)).toEqual(["2026-08-30", "2026-08-31", "2026-09-01"]);
    expect(dayKeysFrom(new Date("2026-08-30T00:00:00.000Z"), 0)).toEqual([]);
  });
});

describe("deltas", () => {
  test("percent change, rounded to one decimal", () => {
    expect(changePct(118, 100)).toBe(18);
    expect(changePct(50, 100)).toBe(-50);
    expect(changePct(231, 115)).toBe(100.9);
  });

  test("no percentage where one would be a lie", () => {
    expect(changePct(10, 0)).toBeNull(); // the seed corpus's 30d comparison window is empty
    expect(changePct(10, null)).toBeNull(); // Free: no previous period served
    expect(changePct(0, 0)).toBeNull();
  });

  test("delta clamps junk to a count and keeps a withheld previous null", () => {
    expect(delta(12.7, 10)).toEqual({ value: 12, previous: 10, changePct: 20 });
    expect(delta(5, null)).toEqual({ value: 5, previous: null, changePct: null });
    expect(delta(Number.NaN, 0)).toEqual({ value: 0, previous: 0, changePct: null });
  });
});

describe("series", () => {
  test("every day is present and missing days are zeros, not gaps", () => {
    const days = ["2026-09-15", "2026-09-16", "2026-09-17"];
    const series = buildSeries(days, {
      views: new Map([["2026-09-15", 4], ["2026-09-17", 2]]),
      opens: new Map([["2026-09-15", 3]]),
      readingTimeMs: new Map([["2026-09-17", 90_000]]),
      downloads: new Map([["2026-09-16", 1]]),
    });
    expect(series.map((p) => p.day)).toEqual(days);
    expect(series.map((p) => p.views)).toEqual([4, 0, 2]);
    expect(series.map((p) => p.opens)).toEqual([3, 0, 0]);
    expect(series.map((p) => p.readingTimeMs)).toEqual([0, 0, 90_000]);
    expect(series.map((p) => p.downloads)).toEqual([0, 1, 0]);
  });

  test("the area under a series equals its headline figure", () => {
    const days = dayKeysFrom(new Date("2026-09-11T00:00:00.000Z"), 7);
    const views = new Map([["2026-09-11", 10], ["2026-09-13", 21], ["2026-09-17", 5]]);
    const series = buildSeries(days, { views, opens: new Map(), readingTimeMs: new Map(), downloads: new Map() });
    expect(series.reduce((a, p) => a + p.views, 0)).toBe(36);
  });
});

describe("averages and hrefs", () => {
  test("average reading time is per viewer, and zero viewers is not a division", () => {
    expect(avgReadingTimeMs(90_000, 4)).toBe(22_500);
    expect(avgReadingTimeMs(1, 3)).toBe(0);
    expect(avgReadingTimeMs(90_000, 0)).toBe(0);
  });

  test("rows lead to the document metrics page, links to it filtered", () => {
    expect(docMetricsHref("6aabaeda4b86405f0713e6b7")).toBe("/doc/6aabaeda4b86405f0713e6b7/metrics");
    expect(linkMetricsHref("6aabaeda4b86405f0713e6b7", "a b/c")).toBe(
      "/doc/6aabaeda4b86405f0713e6b7/metrics?shareId=a%20b%2Fc",
    );
  });
});

/** A top-document row with only the fields ranking looks at. */
function doc(docId: string, views: number, viewers: number, lastOpenedAt: string | null): WorkspaceTopDoc {
  return {
    docId,
    title: docId,
    views,
    viewers,
    opens: 0,
    readingTimeMs: 0,
    avgReadingTimeMs: 0,
    lastOpenedAt,
    href: docMetricsHref(docId),
  };
}

describe("ranking", () => {
  test("documents rank by views, then viewers, then recency, then id", () => {
    const ranked = rankTopDocs(
      [
        doc("b", 10, 4, "2026-09-10T00:00:00.000Z"),
        doc("a", 10, 4, "2026-09-10T00:00:00.000Z"),
        doc("c", 10, 9, "2026-09-01T00:00:00.000Z"),
        doc("d", 40, 1, null),
        doc("e", 10, 4, "2026-09-16T00:00:00.000Z"),
      ],
      3,
    );
    expect(ranked.map((r) => r.docId)).toEqual(["d", "c", "e"]);
  });

  test("links rank the same way and the list is bounded", () => {
    const link = (shareId: string, views: number): WorkspaceTopLink => ({
      shareId,
      shareLinkId: null,
      label: shareId,
      audience: null,
      isDefault: false,
      docId: "doc1",
      docTitle: "Doc",
      views,
      viewers: views,
      lastOpenedAt: null,
      href: linkMetricsHref("doc1", shareId),
    });
    const ranked = rankTopLinks([link("x", 1), link("y", 9), link("z", 5)], 2);
    expect(ranked.map((r) => r.shareId)).toEqual(["y", "z"]);
  });

  test("people rank by reading time, because the question is who is reading", () => {
    const person = (key: string, ms: number, docs: number): WorkspacePerson => ({
      key,
      name: key,
      email: `${key}@example.com`,
      readingTimeMs: ms,
      docs,
      lastSeenAt: null,
    });
    const ranked = rankPeople([person("a", 10, 50), person("b", 900, 1), person("c", 900, 4)], 2);
    expect(ranked.map((r) => r.key)).toEqual(["c", "b"]);
  });
});

describe("gone quiet", () => {
  test("shared documents with no opens, newest share first, bounded", () => {
    const shared = [
      { docId: "old", title: "Old", sharedAt: "2026-01-01T00:00:00.000Z" },
      { docId: "new", title: "New", sharedAt: "2026-09-16T00:00:00.000Z" },
      { docId: "read", title: "Read", sharedAt: "2026-09-15T00:00:00.000Z" },
      { docId: "mid", title: "Mid", sharedAt: "2026-05-05T00:00:00.000Z" },
    ];
    const quiet = selectQuietDocs(shared, new Set(["read"]), 2, NOW.getTime());
    expect(quiet.map((q) => q.docId)).toEqual(["new", "mid"]);
    expect(quiet[0].href).toBe("/doc/new/metrics");
  });

  test("a document shared in the last day has not gone quiet yet", () => {
    // The section header used to read "no opens in 90 days" over eight rows saying "shared 2 hours
    // ago"; the freshest documents crowded out every genuinely stale one.
    const justNow = new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const yesterday = new Date(NOW.getTime() - QUIET_DOC_GRACE_MS - 1000).toISOString();
    const quiet = selectQuietDocs(
      [
        { docId: "fresh", title: "Fresh", sharedAt: justNow },
        { docId: "stale", title: "Stale", sharedAt: yesterday },
      ],
      new Set(),
      5,
      NOW.getTime(),
    );
    expect(quiet.map((q) => q.docId)).toEqual(["stale"]);
  });

  test("a document with no live link is absent rather than dated by something else", () => {
    // `sharedAt: null` means no enabled, unexpired link — nobody can open it, so nudging a
    // recipient about it is advice that cannot work.
    const quiet = selectQuietDocs(
      [
        { docId: "undated", title: "Undated", sharedAt: null },
        { docId: "dated", title: "Dated", sharedAt: "2026-02-02T00:00:00.000Z" },
      ],
      new Set(),
      5,
      NOW.getTime(),
    );
    expect(quiet.map((q) => q.docId)).toEqual(["dated"]);
  });
});

describe("mongo fragments", () => {
  test("the previous-period window is half-open and keeps the legacy fallback branch", () => {
    const start = new Date("2026-07-20T00:00:00.000Z");
    const end = new Date("2026-08-19T00:00:00.000Z");
    expect(activityBetweenMatch(start, end)).toEqual({
      $or: [
        { lastViewedAt: { $gte: start, $lt: end } },
        { lastViewedAt: null, updatedDate: { $gte: start, $lt: end } },
      ],
    });
  });

  test("the previous period also catches a row first seen in it, so a returning reader stays in the baseline", () => {
    const start = new Date("2026-07-20T00:00:00.000Z");
    const end = new Date("2026-08-19T00:00:00.000Z");
    const clauses = presenceBetweenMatch(start, end).$or as Array<Record<string, unknown>>;
    expect(clauses).toHaveLength(3);
    expect(clauses[2]).toEqual({ createdDate: { $gte: start, $lt: end } });
  });

  test("visits are bounded by lastEventAt, bucketed by it, and summed from timeSpentMs", () => {
    const start = new Date("2026-08-19T00:00:00.000Z");
    const end = new Date("2026-09-18T00:00:00.000Z");
    expect(visitWindowMatch(start)).toEqual({ lastEventAt: { $gte: start } });
    expect(visitBetweenMatch(start, end)).toEqual({ lastEventAt: { $gte: start, $lt: end } });
    // A wrong field reference in an aggregation expression yields null, not an error.
    expect(JSON.stringify(VISIT_DAY_KEY_EXPR)).toContain("$lastEventAt");
    expect(JSON.stringify(VISIT_DAY_KEY_EXPR)).toContain("%Y-%m-%d");
    expect(VISIT_TIME_SUM_EXPR).toEqual({ $sum: { $ifNull: ["$timeSpentMs", 0] } });
  });

  test("the workspace scope tolerates a denormalized orgId that has not been backfilled", () => {
    // Tenancy comes from `docId: { $in: <live docs> }`; a plain `{ orgId }` equality silently
    // dropped every row written before the field existed.
    expect(workspaceOrgMatch("org1")).toEqual({ orgId: { $in: ["org1", null] } });
  });

  test("a live link is enabled, unarchived and unexpired", () => {
    const now = new Date("2026-09-17T00:00:00.000Z");
    const expr = liveShareLinkExpr(now).$and as Array<Record<string, unknown>>;
    expect(expr).toHaveLength(3);
    expect(JSON.stringify(expr)).toContain("$enabled");
    expect(JSON.stringify(expr)).toContain("$archivedAt");
    expect(JSON.stringify(expr)).toContain("$expiresAt");
  });

  test("the bucket is (document, link, viewer) — the document page's key plus the document", () => {
    expect(Object.keys(WORKSPACE_VIEWER_KEY_EXPR)).toEqual(["docId", "shareId", "viewer"]);
    expect(WORKSPACE_VIEWER_KEY_EXPR.docId).toBe("$docId");
    expect(WORKSPACE_VIEWER_KEY_EXPR.shareId).toBe("$shareId");
  });

  test("the person key prefers email, falls back to the user id and is otherwise null", () => {
    const expr = WORKSPACE_PERSON_KEY_EXPR as unknown as {
      $let: { vars: { email: unknown }; in: { $cond: unknown[] } };
    };
    expect(JSON.stringify(expr.$let.vars.email)).toContain("viewerEmailSnapshot");
    expect(JSON.stringify(expr.$let.vars.email)).toContain("viewerEmail");
    expect(JSON.stringify(expr.$let.in)).toContain("viewerUserId");
    // The "no identity at all" branch must stay null, so those rows can be dropped by a $match.
    expect(JSON.stringify(expr.$let.in)).toContain("null");
  });

  test("only rows carrying an identity reach the people aggregate", () => {
    expect(WORKSPACE_NAMED_ROW_MATCH).toEqual({
      $or: [{ viewerEmailSnapshot: { $ne: null } }, { viewerEmail: { $ne: null } }, { viewerUserId: { $ne: null } }],
    });
  });
});
