/**
 * The Free-tier analytics teaser (`src/lib/analytics/teaser.ts`; pricing plan 2.1).
 *
 * The basic tier used to stand in for its withheld viewer list with fake blurred rows. The teaser
 * replaces them with real lifetime counts, so two things are pinned here: the payload carries the
 * four numbers/date and nothing that identifies a person, and the pipeline that produces it groups
 * by the same viewer key the window count uses and projects no identity field.
 */
import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ aggregate: vi.fn() }));
vi.mock("@/lib/models/ShareView", () => ({ ShareViewModel: { aggregate: mocks.aggregate } }));

import { LINK_VIEWER_KEY_EXPR, RECIPIENT_ONLY_MATCH } from "@/lib/analytics/shareViewAggregates";
import { buildAnalyticsTeaser, hiddenDaysBefore, teaserFromRow, teaserPipeline } from "@/lib/analytics/teaser";

const WINDOW_START = new Date("2026-09-18T00:00:00Z");
const IDENTITY_KEYS = ["viewerName", "viewerEmail", "viewerEmailSnapshot", "viewerUserId", "company", "pages", "pageTime"];

/** Every key anywhere inside a JSON-ish value. */
function keysDeep(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) node.forEach((n) => keysDeep(n, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out.add(k);
      keysDeep(v, out);
    }
  }
  return out;
}

describe("hiddenDaysBefore", () => {
  it("is 0 with no first view, or a first view inside the window", () => {
    expect(hiddenDaysBefore(null, WINDOW_START)).toBe(0);
    expect(hiddenDaysBefore(new Date("2026-09-18T00:00:00Z"), WINDOW_START)).toBe(0);
    expect(hiddenDaysBefore(new Date("2026-09-20T10:00:00Z"), WINDOW_START)).toBe(0);
  });

  it("counts whole days before the window, rounding a partial day up", () => {
    expect(hiddenDaysBefore(new Date("2026-09-11T00:00:00Z"), WINDOW_START)).toBe(7);
    expect(hiddenDaysBefore(new Date("2026-09-17T23:00:00Z"), WINDOW_START)).toBe(1);
    expect(hiddenDaysBefore(new Date("2026-08-01T12:00:00Z"), WINDOW_START)).toBe(48);
  });
});

describe("teaserFromRow", () => {
  it("returns the four fields and only them", () => {
    const t = teaserFromRow(
      { uniqueViewers: 8, identifiedViewers: 3, firstViewAt: new Date("2026-08-12T09:30:00Z") },
      WINDOW_START,
    );
    expect(t).toEqual({ uniqueViewers: 8, identifiedViewers: 3, firstViewAt: "2026-08-12T09:30:00.000Z", hiddenDays: 37 });
    expect(Object.keys(t).sort()).toEqual(["firstViewAt", "hiddenDays", "identifiedViewers", "uniqueViewers"]);
  });

  it("an empty aggregate is zeros and no date", () => {
    expect(teaserFromRow(undefined, WINDOW_START)).toEqual({
      uniqueViewers: 0,
      identifiedViewers: 0,
      firstViewAt: null,
      hiddenDays: 0,
    });
  });

  it("never reports more identified people than people", () => {
    const t = teaserFromRow({ uniqueViewers: 2, identifiedViewers: 5, firstViewAt: null }, WINDOW_START);
    expect(t.identifiedViewers).toBe(2);
    expect(t.identifiedViewers).toBeLessThanOrEqual(t.uniqueViewers);
  });
});

describe("teaserPipeline", () => {
  const scope = { docId: new Types.ObjectId(), ...RECIPIENT_ONLY_MATCH };
  const pipeline = teaserPipeline(scope);

  it("matches the caller's scope unchanged and with no date bound", () => {
    expect(pipeline[0]).toEqual({ $match: scope });
    expect(keysDeep(pipeline[0])).not.toContain("createdDate");
    expect(keysDeep(pipeline[0])).not.toContain("lastViewedAt");
  });

  it("groups by the same (link, viewer) key the window viewer count uses", () => {
    const group = (pipeline[1] as { $group: { _id: unknown } }).$group;
    expect(group._id).toEqual(LINK_VIEWER_KEY_EXPR);
  });

  it("projects counts and one date, never an identity field", () => {
    const projected = (pipeline[pipeline.length - 1] as { $project: Record<string, unknown> }).$project;
    expect(Object.keys(projected).sort()).toEqual(["_id", "firstViewAt", "identifiedViewers", "uniqueViewers"]);
    for (const k of IDENTITY_KEYS) expect(projected).not.toHaveProperty(k);
  });
});

describe("buildAnalyticsTeaser", () => {
  beforeEach(() => mocks.aggregate.mockReset());

  it("folds the summary row into the payload", async () => {
    mocks.aggregate.mockResolvedValue([
      { uniqueViewers: 5, identifiedViewers: 2, firstViewAt: new Date("2026-09-01T00:00:00Z") },
    ]);
    const t = await buildAnalyticsTeaser({ scopeMatch: { docId: "x" }, windowStart: WINDOW_START });
    expect(t).toEqual({ uniqueViewers: 5, identifiedViewers: 2, firstViewAt: "2026-09-01T00:00:00.000Z", hiddenDays: 17 });
    for (const k of IDENTITY_KEYS) expect(t).not.toHaveProperty(k);
    expect(mocks.aggregate).toHaveBeenCalledTimes(1);
  });
});
