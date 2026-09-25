/**
 * The Free-tier analytics teaser: real counts, no identities.
 *
 * Free workspaces get the basic analytics tier: totals, the chart, and a unique viewer count for a
 * clamped window. The metrics page used to stand in for the withheld viewer list with three blurred
 * placeholder rows, which read as data and were not. Identities are recorded on Free exactly as on
 * Pro (upgrading reveals them retroactively), so the honest teaser is the true shape of what is
 * being withheld: how many distinct people opened this over its whole life, how many of them the
 * system already knows by name or email, when the first one came, and how many days of that history
 * the plan window hides.
 *
 * What never leaves here: a name, an email, a company, a per-page figure, a per-viewer row. The
 * aggregate groups by viewer key only to count, and projects nothing but numbers and one date.
 *
 * Scope is the caller's: pass the same `scopeMatch` the route uses for `viewerCount` (link or
 * document or project, `RECIPIENT_ONLY_MATCH` included, project-link slugs excluded on a document),
 * so the teaser counts exactly the people the window count would, minus the window.
 */
import type { PipelineStage } from "mongoose";

import { ShareViewModel } from "@/lib/models/ShareView";

import { LINK_VIEWER_KEY_EXPR } from "./shareViewAggregates";

/** The basic-tier teaser. Counts and one date; deliberately nothing else. */
export type AnalyticsTeaser = {
  /** Distinct (link, viewer) recipients over the resource's whole history. */
  uniqueViewers: number;
  /** Of those, how many arrived signed in or left an email: the people Pro would name. */
  identifiedViewers: number;
  /** When the first recipient opened it, ISO; `null` when nobody has. */
  firstViewAt: string | null;
  /** Whole days of history before the plan window starts; `0` when everything is inside it. */
  hiddenDays: number;
};

/** One row per viewer bucket is too much; the pipeline folds to this single summary row. */
type TeaserAggRow = {
  uniqueViewers?: number;
  identifiedViewers?: number;
  firstViewAt?: Date | null;
};

/**
 * `true` (as `1`) when a `ShareView` row carries an identity Pro would show: a signed-in user, or
 * an email the viewer typed (live or snapshotted). Used inside `$max` so a viewer identified on any
 * of their rows counts once as identified.
 */
export const IDENTIFIED_VIEWER_EXPR = {
  $cond: [
    {
      $or: [
        { $ne: [{ $ifNull: ["$viewerUserId", null] }, null] },
        { $gt: [{ $strLenCP: { $ifNull: ["$viewerEmail", ""] } }, 0] },
        { $gt: [{ $strLenCP: { $ifNull: ["$viewerEmailSnapshot", ""] } }, 0] },
      ],
    },
    1,
    0,
  ],
} as const;

/**
 * The aggregation pipeline behind {@link buildAnalyticsTeaser}, exported so a test can pin its
 * shape without a database: it must group by the same viewer key `viewerCount` uses and project
 * nothing that identifies anyone.
 */
export function teaserPipeline(scopeMatch: Record<string, unknown>): PipelineStage[] {
  return [
    { $match: scopeMatch },
    {
      $group: {
        _id: LINK_VIEWER_KEY_EXPR,
        identified: { $max: IDENTIFIED_VIEWER_EXPR },
        firstSeen: { $min: "$createdDate" },
      },
    },
    {
      $group: {
        _id: null,
        uniqueViewers: { $sum: 1 },
        identifiedViewers: { $sum: "$identified" },
        firstViewAt: { $min: "$firstSeen" },
      },
    },
    { $project: { _id: 0, uniqueViewers: 1, identifiedViewers: 1, firstViewAt: 1 } },
  ];
}

/** Whole UTC days from `firstViewAt` up to `windowStart`; `0` when the first view is inside the window. */
export function hiddenDaysBefore(firstViewAt: Date | null, windowStart: Date): number {
  if (!firstViewAt) return 0;
  const ms = windowStart.getTime() - firstViewAt.getTime();
  if (!(ms > 0)) return 0;
  return Math.ceil(ms / 86_400_000);
}

/** Fold the pipeline's summary row into the response shape. Pure, so the arithmetic is testable. */
export function teaserFromRow(row: TeaserAggRow | undefined, windowStart: Date): AnalyticsTeaser {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);
  const uniqueViewers = n(row?.uniqueViewers);
  // Never more identified people than people: a malformed row must not produce "5 named, 3 total".
  const identifiedViewers = Math.min(uniqueViewers, n(row?.identifiedViewers));
  const first = row?.firstViewAt instanceof Date && Number.isFinite(row.firstViewAt.getTime()) ? row.firstViewAt : null;
  return {
    uniqueViewers,
    identifiedViewers,
    firstViewAt: first ? first.toISOString() : null,
    hiddenDays: hiddenDaysBefore(first, windowStart),
  };
}

/**
 * Compute the basic-tier teaser for a scope. Runs one aggregate over the resource's whole history
 * (no date bound: the point is what the window hides). Callers on the deep tier should not call
 * this at all; Pro gets the rows themselves.
 */
export async function buildAnalyticsTeaser(params: {
  scopeMatch: Record<string, unknown>;
  windowStart: Date;
}): Promise<AnalyticsTeaser> {
  const rows = (await ShareViewModel.aggregate(teaserPipeline(params.scopeMatch))) as TeaserAggRow[];
  return teaserFromRow(rows[0], params.windowStart);
}
