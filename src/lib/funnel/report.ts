/**
 * The upgrade funnel, per week, for the admin page at `/a/funnel`.
 *
 * Phase 4.1 of docs/reviews/pricing-upsell-fix-plan-2026-09-23.md put a row in `ActivityEvent`
 * at every step: the wall (`plan.limit_reached`, written by `planLimitResponse`), the prompt
 * (`funnel.modal_shown`), the press (`funnel.cta_clicked`), the Free analytics teaser
 * (`funnel.teaser_shown`), the Checkout (`checkout.started`, `meta.kind` pro or credit_pack) and
 * the outcome (`plan.upgraded`, from the Stripe webhook). This module turns those rows, plus
 * workspace creation dates from `Org`, into one table: for each ISO week (UTC, Monday start), how
 * many distinct workspaces reached each step. Workspaces, not events: one person retrying a wall
 * twenty times is one frustrated person, not demand.
 *
 * Every activity read here is `type: { $in: [...] }` plus a `createdDate` lower bound. The
 * collection's `type_1` index serves the `$in`, so the scan is bounded by the funnel rows
 * themselves (new types, and `plan.limit_reached`, all a small fraction of the feed), never by
 * the whole collection. The "first wall" question is deliberately unbounded in time: a wall this
 * week is only somebody's first if they never hit one before, so that read groups every
 * `plan.limit_reached` row by workspace and keeps the earliest. It is still index-served by type.
 *
 * Pipeline builders are exported so a test can pin their shape without a database; the loader is
 * what the route calls.
 */
import type { PipelineStage, Types } from "mongoose";

import { ActivityEventModel } from "@/lib/models/ActivityEvent";
import { OrgModel } from "@/lib/models/Org";
import { connectMongo } from "@/lib/mongodb";

/** The activity types that make up the funnel, in step order. */
export const FUNNEL_STEP_TYPES = [
  "plan.limit_reached",
  "funnel.modal_shown",
  "funnel.cta_clicked",
  "funnel.teaser_shown",
  "checkout.started",
  "plan.upgraded",
] as const;

/** What can be pressed on a modal; mirrors `FUNNEL_CTAS` in the funnel route. */
export const FUNNEL_REPORT_CTAS = ["upgrade", "pack", "compare", "manage", "dismiss"] as const;
export type FunnelReportCta = (typeof FUNNEL_REPORT_CTAS)[number];

/** One ISO week of the funnel. Every count is distinct workspaces in that week. */
export type FunnelWeek = {
  /** Monday of the ISO week, `YYYY-MM-DD`, UTC. */
  week: string;
  /** Workspaces created (`Org.createdDate`). */
  signups: number;
  /** Workspaces whose first ever `plan.limit_reached` fell in this week. */
  firstWalls: number;
  /** Workspaces that hit any wall this week, first or not. */
  walls: number;
  /** Workspaces shown the upgrade or out-of-credits modal. */
  modalShown: number;
  /** Workspaces that pressed each button on a modal. */
  ctaClicked: Record<FunnelReportCta, number>;
  /** Workspaces shown the Free analytics teaser. */
  teaserShown: number;
  /** Median of `uniqueViewers` at the moment the teaser was shown; null with no rows. */
  teaserMedianViewers: number | null;
  /** Workspaces that started a Pro Checkout (`meta.kind: "pro"`). */
  checkoutPro: number;
  /** Workspaces that started a credit-pack Checkout (`meta.kind: "credit_pack"`). */
  checkoutPack: number;
  /** Workspaces the webhook moved to Pro. */
  upgraded: number;
};

/** The whole report. */
export type FunnelReport = {
  /** Start of the earliest week shown (inclusive), ISO. */
  since: string;
  /** When the report was computed, ISO. */
  until: string;
  weeks: FunnelWeek[];
  firstWall: {
    /** Median days from workspace creation to its first wall, over first walls in the window; null with none. */
    medianDays: number | null;
    /** How many workspaces' first wall fell in the window. */
    workspaces: number;
    /** Which limit is the first wall, most common first. */
    byLimit: Array<{ limit: string; workspaces: number }>;
  };
};

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** Monday 00:00 UTC of the ISO week containing `d`. */
export function isoWeekStart(d: Date): Date {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // getUTCDay: Sunday 0 .. Saturday 6; ISO weeks start on Monday.
  const back = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - back * DAY_MS);
}

/** `YYYY-MM-DD` of a date, UTC. */
export function weekKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The Monday that starts the window: `weeks` ISO weeks back from the current one, inclusive. */
export function funnelWindowStart(now: Date, weeks: number): Date {
  const thisWeek = isoWeekStart(now);
  return new Date(thisWeek.getTime() - (Math.max(1, weeks) - 1) * WEEK_MS);
}

/** The `$dateTrunc` expression every pipeline groups on: ISO week, Monday start, UTC. */
const WEEK_EXPR = { $dateTrunc: { date: "$createdDate", unit: "week", startOfWeek: "monday", timezone: "UTC" } };

/**
 * Distinct workspaces per (week, type, cta, kind) for every funnel type in the window.
 *
 * Two groups: the first collapses a workspace's repeats within a week, the second counts the
 * workspaces. `cta` and `kind` only mean something on `funnel.cta_clicked` and `checkout.started`
 * respectively; they group as null on the other types.
 */
export function funnelStepsPipeline(since: Date): PipelineStage[] {
  return [
    { $match: { type: { $in: [...FUNNEL_STEP_TYPES] }, createdDate: { $gte: since } } },
    {
      $group: {
        _id: { week: WEEK_EXPR, type: "$type", orgId: "$orgId", cta: "$meta.cta", kind: "$meta.kind" },
      },
    },
    {
      $group: {
        _id: { week: "$_id.week", type: "$_id.type", cta: "$_id.cta", kind: "$_id.kind" },
        workspaces: { $sum: 1 },
      },
    },
  ];
}

/** Every workspace's first ever wall: when, and which limit. Unbounded in time on purpose (see the module note). */
export function firstWallPipeline(): PipelineStage[] {
  return [
    { $match: { type: "plan.limit_reached" } },
    { $sort: { createdDate: 1 } },
    { $group: { _id: "$orgId", at: { $first: "$createdDate" }, limit: { $first: "$meta.limit" } } },
  ];
}

/** Teaser rows in the window: the week and the viewer count the person was shown. */
export function teaserRowsPipeline(since: Date): PipelineStage[] {
  return [
    { $match: { type: "funnel.teaser_shown", createdDate: { $gte: since } } },
    { $project: { _id: 0, week: WEEK_EXPR, uniqueViewers: "$meta.uniqueViewers" } },
    { $limit: 20_000 },
  ];
}

/** Workspaces created per ISO week in the window. */
export function signupsPipeline(since: Date): PipelineStage[] {
  return [
    { $match: { createdDate: { $gte: since } } },
    { $group: { _id: WEEK_EXPR, signups: { $sum: 1 } } },
  ];
}

/** The median of a list of numbers; null for an empty list. */
export function median(values: number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function emptyWeek(week: string): FunnelWeek {
  return {
    week,
    signups: 0,
    firstWalls: 0,
    walls: 0,
    modalShown: 0,
    ctaClicked: { upgrade: 0, pack: 0, compare: 0, manage: 0, dismiss: 0 },
    teaserShown: 0,
    teaserMedianViewers: null,
    checkoutPro: 0,
    checkoutPack: 0,
    upgraded: 0,
  };
}

type StepRow = { _id: { week: Date | null; type: string; cta?: unknown; kind?: unknown }; workspaces: number };
type FirstWallRow = { _id: Types.ObjectId; at: Date; limit?: unknown };
type TeaserRow = { week: Date | null; uniqueViewers?: unknown };
type SignupRow = { _id: Date | null; signups: number };
type OrgRow = { _id: Types.ObjectId; createdDate?: Date };

/**
 * Fold the four reads into the report. Pure, so the shape can be tested without a database.
 */
export function buildFunnelReport(input: {
  now: Date;
  weeks: number;
  steps: StepRow[];
  firstWalls: FirstWallRow[];
  orgCreated: Map<string, Date>;
  teaser: TeaserRow[];
  signups: SignupRow[];
}): FunnelReport {
  const since = funnelWindowStart(input.now, input.weeks);
  const byWeek = new Map<string, FunnelWeek>();
  for (let i = 0; i < input.weeks; i++) {
    const key = weekKey(new Date(since.getTime() + i * WEEK_MS));
    byWeek.set(key, emptyWeek(key));
  }
  const weekOf = (d: Date | null | undefined): FunnelWeek | null => {
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
    return byWeek.get(weekKey(isoWeekStart(d))) ?? null;
  };

  for (const row of input.signups) {
    const w = weekOf(row._id);
    if (w) w.signups += Number(row.signups) || 0;
  }

  for (const row of input.steps) {
    const w = weekOf(row._id.week);
    if (!w) continue;
    const n = Number(row.workspaces) || 0;
    switch (row._id.type) {
      case "plan.limit_reached":
        w.walls += n;
        break;
      case "funnel.modal_shown":
        w.modalShown += n;
        break;
      case "funnel.cta_clicked": {
        const cta = typeof row._id.cta === "string" ? row._id.cta : "";
        if ((FUNNEL_REPORT_CTAS as readonly string[]).includes(cta)) w.ctaClicked[cta as FunnelReportCta] += n;
        break;
      }
      case "funnel.teaser_shown":
        w.teaserShown += n;
        break;
      case "checkout.started":
        if (row._id.kind === "credit_pack") w.checkoutPack += n;
        else w.checkoutPro += n;
        break;
      case "plan.upgraded":
        w.upgraded += n;
        break;
      default:
        break;
    }
  }

  const teaserByWeek = new Map<string, number[]>();
  for (const row of input.teaser) {
    const w = weekOf(row.week);
    const v = typeof row.uniqueViewers === "number" ? row.uniqueViewers : Number(row.uniqueViewers);
    if (!w || !Number.isFinite(v)) continue;
    const list = teaserByWeek.get(w.week) ?? [];
    list.push(v);
    teaserByWeek.set(w.week, list);
  }
  for (const [key, list] of teaserByWeek) {
    const w = byWeek.get(key);
    if (w) w.teaserMedianViewers = median(list);
  }

  const days: number[] = [];
  const limitCounts = new Map<string, number>();
  let firstWallWorkspaces = 0;
  for (const row of input.firstWalls) {
    const w = weekOf(row.at);
    if (!w) continue; // first wall outside the window: not this report's
    w.firstWalls += 1;
    firstWallWorkspaces += 1;
    const limit = typeof row.limit === "string" && row.limit ? row.limit : "unknown";
    limitCounts.set(limit, (limitCounts.get(limit) ?? 0) + 1);
    const created = input.orgCreated.get(String(row._id));
    if (created instanceof Date && !Number.isNaN(created.getTime())) {
      days.push(Math.max(0, (row.at.getTime() - created.getTime()) / DAY_MS));
    }
  }
  const medianDaysRaw = median(days);

  return {
    since: since.toISOString(),
    until: input.now.toISOString(),
    weeks: [...byWeek.values()],
    firstWall: {
      medianDays: medianDaysRaw === null ? null : Math.round(medianDaysRaw * 10) / 10,
      workspaces: firstWallWorkspaces,
      byLimit: [...limitCounts.entries()]
        .map(([limit, workspaces]) => ({ limit, workspaces }))
        .sort((a, b) => b.workspaces - a.workspaces || a.limit.localeCompare(b.limit)),
    },
  };
}

/** Read the funnel for the last `weeks` ISO weeks (the current one included). */
export async function loadFunnelReport(params: { weeks?: number; now?: Date } = {}): Promise<FunnelReport> {
  const now = params.now ?? new Date();
  const weeks = Math.min(26, Math.max(1, Math.floor(params.weeks ?? 8)));
  const since = funnelWindowStart(now, weeks);
  await connectMongo();

  const [steps, firstWalls, teaser, signups] = await Promise.all([
    ActivityEventModel.aggregate<StepRow>(funnelStepsPipeline(since)),
    ActivityEventModel.aggregate<FirstWallRow>(firstWallPipeline()),
    ActivityEventModel.aggregate<TeaserRow>(teaserRowsPipeline(since)),
    OrgModel.aggregate<SignupRow>(signupsPipeline(since)),
  ]);

  // Creation dates only for the workspaces whose first wall is in the window: the median is over
  // those, and it keeps the Org read to a handful of ids.
  const inWindow = firstWalls.filter((r) => r.at instanceof Date && r.at.getTime() >= since.getTime());
  const orgs = inWindow.length
    ? await OrgModel.find({ _id: { $in: inWindow.map((r) => r._id) } })
        .select({ _id: 1, createdDate: 1 })
        .lean<OrgRow[]>()
    : [];
  const orgCreated = new Map<string, Date>();
  for (const o of orgs) if (o.createdDate instanceof Date) orgCreated.set(String(o._id), o.createdDate);

  return buildFunnelReport({ now, weeks, steps, firstWalls, orgCreated, teaser, signups });
}
