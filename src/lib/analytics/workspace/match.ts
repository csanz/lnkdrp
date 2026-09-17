/**
 * The Mongo `$match` / `$group` fragments the workspace aggregation is built from.
 *
 * They live beside the pure helpers rather than inside the route for the same reason
 * `shareViewAggregates.ts` exists: a wrong field reference in an aggregation expression yields
 * `null` instead of an error, so these shapes are pinned by tests (tests/lib/workspaceMetrics.test.ts)
 * rather than trusted. Everything document-scoped is imported from `shareViewAggregates.ts` so the
 * workspace figures cannot drift from the document ones.
 */
import { LAST_ACTIVITY_EXPR, LINK_VIEWER_KEY_EXPR } from "@/lib/analytics/shareViewAggregates";

/**
 * "Last activity inside `[start, end)`" — {@link activityWindowMatch} with an upper bound.
 *
 * Only the previous period needs this: the current window runs to now, so it has no upper bound.
 * The `lastViewedAt: null` branch mirrors the unbounded version, which is what lets rows written
 * before `lastViewedAt` existed fall back to `updatedDate` instead of vanishing from the comparison
 * and inventing a rise.
 */
export function activityBetweenMatch(start: Date, end: Date): Record<string, unknown> {
  return {
    $or: [
      { lastViewedAt: { $gte: start, $lt: end } },
      { lastViewedAt: null, updatedDate: { $gte: start, $lt: end } },
    ],
  };
}

/**
 * The previous period for the `shareviews` figures: active in `[start, end)` **or first seen in it**.
 *
 * A `ShareView` row carries one `lastViewedAt`, so {@link activityBetweenMatch} alone erases from
 * the baseline every reader who was active in the previous period and came back in the current one
 * — their row's last activity has moved forward. That inflates every change chip, and it inflates
 * it most on the workspaces whose readers actually return, which is the opposite of useful. The
 * `createdDate` clause puts those rows back: a row created inside the previous window demonstrably
 * had its first view there.
 *
 * Still a floor, not a truth: a row created *before* the previous window, active in it, and active
 * again now is counted only once, in the current period. Counting that case honestly needs a
 * per-event source, which is what {@link visitBetweenMatch} is for — the opens and reading-time
 * comparisons use it. Views has no per-event source, so a floor that leans against the rise is the
 * honest choice over one that leans into it.
 */
export function presenceBetweenMatch(start: Date, end: Date): Record<string, unknown> {
  return {
    $or: [
      { lastViewedAt: { $gte: start, $lt: end } },
      { lastViewedAt: null, updatedDate: { $gte: start, $lt: end } },
      { createdDate: { $gte: start, $lt: end } },
    ],
  };
}

/**
 * Visits active in the window — the `sharevisits` equivalent of `activityWindowMatch`.
 *
 * `lastEventAt` is required on the model, so there is no null branch to fall back through: unlike
 * `shareviews`, every visit row has a real timestamp. Same bound as the document route uses for
 * `totals.opens` and `totals.visitTimeMs` (src/app/api/docs/[docId]/shareviews/route.ts).
 */
export function visitWindowMatch(start: Date): Record<string, unknown> {
  return { lastEventAt: { $gte: start } };
}

/** {@link visitWindowMatch} with an upper bound, for the previous period. */
export function visitBetweenMatch(start: Date, end: Date): Record<string, unknown> {
  return { lastEventAt: { $gte: start, $lt: end } };
}

/**
 * The UTC day a visit is counted on: the day it was last active.
 *
 * Deliberately the same rule as `ACTIVITY_DAY_KEY_EXPR` uses for views, so the two series on this
 * page bucket the same way and the area under each still equals its headline figure.
 */
export const VISIT_DAY_KEY_EXPR = {
  $dateToString: { date: "$lastEventAt", format: "%Y-%m-%d", timezone: "UTC" },
} as const;

/**
 * Reading time actually recorded *in the window*: `sharevisits.timeSpentMs`, one row per tab
 * session, so a sum over the window's visits is time read in the window and nothing else.
 *
 * The obvious-looking alternative, summing `shareviews.timeSpentMs`, is wrong and was shipped once:
 * that field is a **lifetime** per-(link, viewer) counter (src/lib/models/ShareView.ts), so a reader
 * who spent two hours on a deck in July and reopened it for five seconds yesterday dragged the whole
 * two hours into the 7-day figure — and onto yesterday's point of the chart. The PRD names this trap
 * explicitly ("anything range-scoped comes from `sharevisits` or from day maps, never from the
 * lifetime counters"); the document route computes the same figure as `totals.visitTimeMs`.
 *
 * It backs the people list too, which was the last place `shareviews.timeSpentMs` survived: a
 * ranking a range control governs cannot be built on a counter the range does not bound.
 */
export const VISIT_TIME_SUM_EXPR = { $sum: { $ifNull: ["$timeSpentMs", 0] } } as const;

/**
 * The bucket every workspace figure is built on: one (document, link, viewer).
 *
 * `LINK_VIEWER_KEY_EXPR` unchanged, with the document added. Counting a viewer once per *link*
 * (not once per person) is what makes a document's row here equal the `viewerCount` on its own
 * metrics page and makes the workspace headline the sum of its documents. Distinct people across
 * documents is a different number and is reported separately, as `people.count`.
 */
export const WORKSPACE_VIEWER_KEY_EXPR = { docId: "$docId", ...LINK_VIEWER_KEY_EXPR } as const;

/**
 * Who a `ShareView` row belongs to *across* documents: the viewer's email if it has one, else the
 * signed-in user id, else nothing.
 *
 * Email first because that is the identity a sender recognises and the only one that joins an
 * anonymous reader on the Sequoia link to the same reader on the Accel link. A row with neither
 * resolves to `null` and is dropped — an anonymous browser id is not a person a sender can name, so
 * listing it would pad the list with rows nobody can act on.
 */
export const WORKSPACE_PERSON_KEY_EXPR = {
  $let: {
    vars: {
      email: {
        $toLower: { $trim: { input: { $ifNull: ["$viewerEmailSnapshot", { $ifNull: ["$viewerEmail", ""] }] } } },
      },
    },
    in: {
      $cond: [
        { $ne: ["$$email", ""] },
        { $concat: ["e:", "$$email"] },
        {
          $cond: [
            { $ne: [{ $ifNull: ["$viewerUserId", null] }, null] },
            { $concat: ["u:", { $toString: "$viewerUserId" }] },
            null,
          ],
        },
      ],
    },
  },
} as const;

/** Rows that carry an identity at all — the only ones the people list considers. */
export const WORKSPACE_NAMED_ROW_MATCH: Record<string, unknown> = {
  $or: [{ viewerEmailSnapshot: { $ne: null } }, { viewerEmail: { $ne: null } }, { viewerUserId: { $ne: null } }],
};

/**
 * Workspace scope for a denormalized `orgId` that may not be backfilled yet.
 *
 * Tenancy is carried by `docId: { $in: <this workspace's live documents> }`, which every pipeline
 * here already has; this term exists only so the planner can use the `orgId`-prefixed window
 * indexes. `ShareView.orgId` / `ShareVisit.orgId` default to `null` on rows written before the field
 * existed (until `scripts/sharelinks-analytics-backfill.ts` runs), and a plain `{ orgId }` equality
 * silently dropped that traffic — under-reporting against the very document pages this page links
 * to. `$in` keeps both index branches and loses nothing.
 */
export function workspaceOrgMatch(orgId: unknown): Record<string, unknown> {
  return { orgId: { $in: [orgId, null] } };
}

/** Most recent real activity among the matched rows. Never `updatedDate` alone — see `LAST_ACTIVITY_EXPR`. */
export const LAST_SEEN_MAX_EXPR = { $max: LAST_ACTIVITY_EXPR } as const;

/**
 * Whether a `ShareLink` row is one a recipient could actually open right now: enabled, not
 * archived, not expired.
 *
 * An aggregation expression rather than a `$match`, because the quiet list wants the newest *live*
 * link of each document in the same `$group` that reads its first link of any kind. Mirrors
 * `isLinkActive` and the share-link reads in `src/app/api/docs/[docId]/shareviews/route.ts`; the
 * `$ifNull` defaults match the model's (`enabled` defaults true, `archivedAt` / `expiresAt` null).
 *
 * It matters for the "Gone quiet" list: a document whose only link is switched off or expired was
 * listed there with a nudge to chase a recipient who cannot open it.
 */
export function liveShareLinkExpr(now: Date): Record<string, unknown> {
  return {
    $and: [
      { $ne: [{ $ifNull: ["$enabled", true] }, false] },
      { $eq: [{ $ifNull: ["$archivedAt", null] }, null] },
      { $or: [{ $eq: [{ $ifNull: ["$expiresAt", null] }, null] }, { $gt: ["$expiresAt", now] }] },
    ],
  };
}
