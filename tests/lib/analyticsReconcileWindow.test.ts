/**
 * The nightly analytics reconcile is bounded to a window and index-friendly (code review
 * 2026-09-23, M9): the counter pass picks links by a single-field activity filter and recomputes
 * only those, and the window comes from the cron request's query.
 */
import { describe, expect, it } from "vitest";

import {
  activeSinceFilter,
  counterWindowStart,
  DEFAULT_COUNTER_WINDOW_DAYS,
  linkTruthPipeline,
} from "@/lib/analytics/reconcileLinkCounters";

const DAY = 24 * 60 * 60 * 1000;

describe("counterWindowStart", () => {
  const now = Date.parse("2026-09-25T03:50:00Z");

  it("defaults to two days back", () => {
    const start = counterWindowStart(new URL("http://x/api/cron/analytics-reconcile"), now);
    expect(start?.getTime()).toBe(now - DEFAULT_COUNTER_WINDOW_DAYS * DAY);
  });

  it("honours ?days=N, capped at a year, and ?full=1 means no window", () => {
    expect(counterWindowStart(new URL("http://x/?days=7"), now)?.getTime()).toBe(now - 7 * DAY);
    expect(counterWindowStart(new URL("http://x/?days=9999"), now)?.getTime()).toBe(now - 365 * DAY);
    expect(counterWindowStart(new URL("http://x/?days=0"), now)?.getTime()).toBe(now - DEFAULT_COUNTER_WINDOW_DAYS * DAY);
    expect(counterWindowStart(new URL("http://x/?full=1&days=7"), now)).toBeNull();
  });
});

describe("activeSinceFilter", () => {
  it("is a single-field range, so the lastViewedAt index serves it", () => {
    const since = new Date("2026-09-23T00:00:00Z");
    expect(activeSinceFilter(since)).toEqual({ lastViewedAt: { $gte: since } });
    expect(activeSinceFilter(since, { orgId: "o" })).toEqual({ orgId: "o", lastViewedAt: { $gte: since } });
  });
});

describe("linkTruthPipeline", () => {
  it("binds the match to the candidate slugs and excludes project slugs on the same key", () => {
    const [match] = linkTruthPipeline({ projectSlugs: ["room1"], slugs: ["a", "b"] }) as unknown as Array<{ $match: Record<string, unknown> }>;
    expect(match.$match).toEqual({ isOwnerPreview: { $ne: true }, shareId: { $in: ["a", "b"], $nin: ["room1"] } });
  });

  it("with no window and no project links, matches every recipient row", () => {
    const [match, group] = linkTruthPipeline({ projectSlugs: [], slugs: null }) as unknown as Array<Record<string, unknown>>;
    expect(match.$match).toEqual({ isOwnerPreview: { $ne: true } });
    expect((group.$group as { _id: string })._id).toBe("$shareId");
  });

  it("keeps the recipient-only rule and the lastViewedAt-before-updatedDate rule", () => {
    const [, group] = linkTruthPipeline({ projectSlugs: [], slugs: ["a"] }) as unknown as Array<{ $group: Record<string, unknown> }>;
    expect(group.$group.lastViewedAt).toEqual({ $max: { $ifNull: ["$lastViewedAt", "$updatedDate"] } });
    expect(group.$group.viewCount).toEqual({ $sum: 1 });
  });
});
