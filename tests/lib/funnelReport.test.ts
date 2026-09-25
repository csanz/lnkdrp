/**
 * The funnel report (`src/lib/funnel/report.ts`, pricing plan Phase 4.2).
 *
 * Pins the two things the page depends on: the pipelines read funnel rows by type with a date
 * bound (no unbounded scan of the feed), and the fold counts workspaces per ISO week and answers
 * the two Phase 5 questions (days to first wall, which wall first).
 */
import { Types } from "mongoose";
import { describe, expect, it } from "vitest";

import {
  buildFunnelReport,
  firstWallPipeline,
  FUNNEL_STEP_TYPES,
  funnelStepsPipeline,
  funnelWindowStart,
  isoWeekStart,
  median,
  signupsPipeline,
  teaserRowsPipeline,
} from "@/lib/funnel/report";

const ORG_A = new Types.ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa");
const ORG_B = new Types.ObjectId("bbbbbbbbbbbbbbbbbbbbbbbb");
// A Thursday; its ISO week starts Monday 2026-09-21.
const NOW = new Date("2026-09-24T15:00:00Z");

describe("weeks", () => {
  it("isoWeekStart is the Monday, in UTC, on every day of the week", () => {
    expect(isoWeekStart(new Date("2026-09-21T00:00:00Z")).toISOString()).toBe("2026-09-21T00:00:00.000Z"); // Monday
    expect(isoWeekStart(new Date("2026-09-24T23:59:59Z")).toISOString()).toBe("2026-09-21T00:00:00.000Z"); // Thursday
    expect(isoWeekStart(new Date("2026-09-27T12:00:00Z")).toISOString()).toBe("2026-09-21T00:00:00.000Z"); // Sunday
    expect(isoWeekStart(new Date("2026-09-28T00:00:00Z")).toISOString()).toBe("2026-09-28T00:00:00.000Z"); // next Monday
  });

  it("an 8-week window starts 7 Mondays before the current one", () => {
    expect(funnelWindowStart(NOW, 8).toISOString()).toBe("2026-08-03T00:00:00.000Z");
    expect(funnelWindowStart(NOW, 1).toISOString()).toBe("2026-09-21T00:00:00.000Z");
  });

  it("median handles odd, even and empty lists", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("pipelines", () => {
  const since = funnelWindowStart(NOW, 8);

  it("read the funnel types with a date bound, and group to distinct workspaces", () => {
    const [match, perOrg, perStep] = funnelStepsPipeline(since) as unknown as Array<Record<string, unknown>>;
    expect(match).toEqual({ $match: { type: { $in: [...FUNNEL_STEP_TYPES] }, createdDate: { $gte: since } } });
    // First group carries orgId (collapse repeats), second does not (count workspaces).
    expect(JSON.stringify(perOrg)).toContain('"orgId":"$orgId"');
    expect(JSON.stringify(perStep)).not.toContain("orgId");
    expect(JSON.stringify(perStep)).toContain('"workspaces":{"$sum":1}');
  });

  it("first wall is the earliest plan.limit_reached per workspace, unbounded in time", () => {
    const [match, sort, group] = firstWallPipeline() as unknown as Array<Record<string, unknown>>;
    expect(match).toEqual({ $match: { type: "plan.limit_reached" } });
    expect(sort).toEqual({ $sort: { createdDate: 1 } });
    expect(group).toEqual({ $group: { _id: "$orgId", at: { $first: "$createdDate" }, limit: { $first: "$meta.limit" } } });
  });

  it("teaser rows and sign-ups are bounded by the window", () => {
    expect((teaserRowsPipeline(since)[0] as unknown as Record<string, unknown>).$match).toEqual({
      type: "funnel.teaser_shown",
      createdDate: { $gte: since },
    });
    expect((signupsPipeline(since)[0] as unknown as Record<string, unknown>).$match).toEqual({ createdDate: { $gte: since } });
  });
});

describe("buildFunnelReport", () => {
  const week = (iso: string) => new Date(iso);

  it("counts workspaces per week at each step and answers the first-wall questions", () => {
    const report = buildFunnelReport({
      now: NOW,
      weeks: 2,
      steps: [
        { _id: { week: week("2026-09-14T00:00:00Z"), type: "plan.limit_reached" }, workspaces: 2 },
        { _id: { week: week("2026-09-21T00:00:00Z"), type: "funnel.modal_shown" }, workspaces: 2 },
        { _id: { week: week("2026-09-21T00:00:00Z"), type: "funnel.cta_clicked", cta: "upgrade" }, workspaces: 1 },
        { _id: { week: week("2026-09-21T00:00:00Z"), type: "funnel.cta_clicked", cta: "dismiss" }, workspaces: 1 },
        { _id: { week: week("2026-09-21T00:00:00Z"), type: "funnel.teaser_shown" }, workspaces: 1 },
        { _id: { week: week("2026-09-21T00:00:00Z"), type: "checkout.started", kind: "pro" }, workspaces: 1 },
        { _id: { week: week("2026-09-21T00:00:00Z"), type: "checkout.started", kind: "credit_pack" }, workspaces: 1 },
        { _id: { week: week("2026-09-21T00:00:00Z"), type: "plan.upgraded" }, workspaces: 1 },
        // Outside the window: ignored, not thrown.
        { _id: { week: week("2026-06-01T00:00:00Z"), type: "plan.upgraded" }, workspaces: 9 },
      ],
      firstWalls: [
        { _id: ORG_A, at: new Date("2026-09-16T10:00:00Z"), limit: "documents" },
        { _id: ORG_B, at: new Date("2026-09-23T10:00:00Z"), limit: "documents" },
        // A first wall before the window: not this report's.
        { _id: new Types.ObjectId(), at: new Date("2026-01-01T00:00:00Z"), limit: "projects" },
      ],
      orgCreated: new Map([
        [String(ORG_A), new Date("2026-09-12T10:00:00Z")], // 4 days
        [String(ORG_B), new Date("2026-09-13T10:00:00Z")], // 10 days
      ]),
      teaser: [
        { week: week("2026-09-21T00:00:00Z"), uniqueViewers: 20 },
        { week: week("2026-09-21T00:00:00Z"), uniqueViewers: 4 },
        { week: week("2026-09-21T00:00:00Z"), uniqueViewers: 7 },
      ],
      signups: [{ _id: week("2026-09-21T00:00:00Z"), signups: 3 }],
    });

    expect(report.weeks.map((w) => w.week)).toEqual(["2026-09-14", "2026-09-21"]);
    const [prev, cur] = report.weeks;
    expect(prev).toMatchObject({ walls: 2, firstWalls: 1, signups: 0, modalShown: 0 });
    expect(cur).toMatchObject({
      signups: 3,
      firstWalls: 1,
      walls: 0,
      modalShown: 2,
      ctaClicked: { upgrade: 1, pack: 0, compare: 0, manage: 0, dismiss: 1 },
      teaserShown: 1,
      teaserMedianViewers: 7,
      checkoutPro: 1,
      checkoutPack: 1,
      upgraded: 1,
    });
    expect(report.firstWall).toEqual({ medianDays: 7, workspaces: 2, byLimit: [{ limit: "documents", workspaces: 2 }] });
  });

  it("with nothing recorded every week is zero and the medians are null", () => {
    const report = buildFunnelReport({ now: NOW, weeks: 8, steps: [], firstWalls: [], orgCreated: new Map(), teaser: [], signups: [] });
    expect(report.weeks).toHaveLength(8);
    expect(report.weeks[0].week).toBe("2026-08-03");
    expect(report.weeks.every((w) => w.signups === 0 && w.upgraded === 0 && w.teaserMedianViewers === null)).toBe(true);
    expect(report.firstWall).toEqual({ medianDays: null, workspaces: 0, byLimit: [] });
  });
});
