/**
 * The two aggregates a project has and a document does not: **landings** and the **per-document
 * ranking** (docs/prds/lnkdrp-project-links.md milestone M4, docs/METRICS.md).
 *
 * Everything else on `/api/projects/:projectId/shareviews` is the document route's arithmetic over
 * a different `$match` and is built from `../shareViewAggregates.ts`, which both routes import so
 * they cannot drift on what "active in the window" or "a recipient" means. These two cannot be
 * shared, because the questions do not exist on a document:
 *
 * - A document link has one destination, so arriving and opening are the same event. A project
 *   link has a **landing page**: someone can open `/p/:shareId`, read the file list and leave
 *   without opening anything. `ShareView` never hears about that person — `ProjectLinkView` is the
 *   only record they exist — and on a data room they are frequently the majority.
 * - A document's internal ranking is by page; a project's is by **document**. "Which file did they
 *   go to first" is the data-room equivalent of "how far into the deck did they get".
 *
 * Each pipeline is paired with a pure shaper so the route never does arithmetic inline and the
 * arithmetic can be tested without a database (tests/lib/projectMetrics.test.ts). The Mongo
 * expressions here fail *silently* when they are wrong — a bad reference yields `null`, the route's
 * `?? 0` turns it into a zero, and the page renders a confident wrong number — so the tests pin the
 * field references as well as the sums.
 */
import type { PipelineStage } from "mongoose";

import { LAST_ACTIVITY_EXPR, activityWindowMatch } from "../shareViewAggregates";
import { PROJECT_LINK_VIEWER_KEY_EXPR } from "./viewerKey";

/** Non-negative integer, or `0` — the same coercion the routes apply to every aggregate result. */
function n0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
}

// --- Landings ---------------------------------------------------------------------------------

/** What `landingsPipeline` returns, before shaping. */
export type RawLandingRollup = { landings?: number; landedWithoutOpening?: number; visitors?: number };

/** The project-only figures behind the "landed without opening" clause on the VIEWS tile. */
export type LandingRollup = {
  /**
   * Landings on `/p/:shareId` **in the window**, counted per tab session. A recipient who reloads
   * the file list four times looking for the term sheet made one landing.
   *
   * Summed from `ProjectLinkView.landingsByDay`, exactly as downloads are summed from
   * `downloadsByDay`, and for the same reason: the row's `visits` counter is *cumulative* while the
   * window selects rows by last activity, so summing it reported a recipient's entire six-month
   * history inside a three-day window — forty landings on a page whose other tiles said one person
   * came back once.
   */
  landings: number;
  /**
   * Visitors who reached the project page and opened **nothing**. The fact a document cannot have,
   * and the one that changes what a data room's owner does next.
   *
   * Counted over `ProjectLinkView` rows whose landing falls in the window and whose `docsOpened` is
   * still empty. `docsOpened` is lifetime, not windowed, and deliberately so: a person who opened a
   * file last month and only skimmed the list today has *not* "landed without opening" — they know
   * what is in there. The figure means "has never opened anything through this link", which is the
   * claim the UI makes.
   */
  landedWithoutOpening: number;
  /**
   * The (link, device) rows that **landed in the window** — the people, where `landings` is the
   * visits. Not every row the window matched: a `ProjectLinkView` row is also created for a
   * recipient who deep-links straight to a document and never opens the project page.
   *
   * Residual ambiguity, and the conservative direction: a genuine landing from a browser that
   * blocks the session id leaves `visits: 0` and no per-day key, so it reads as no landing rather
   * than as one. Under-reporting a landing is a figure a sender can live with; inventing one for a
   * link nobody opened is not.
   */
  visitors: number;
};

/**
 * Landings for one scope, bounded by the same window rule as every other figure on the page.
 *
 * `match` must already carry the scope's `shareId` clause and `RECIPIENT_ONLY_MATCH`: a
 * `ProjectLinkView` row records the owner's own visit to their link for the same reason
 * `ShareView` does, and counting it would tell an owner their data room had traffic when the only
 * traffic was them checking it opened.
 */
export function landingsPipeline(match: Record<string, unknown>, start: Date): PipelineStage[] {
  // The by-day keys are UTC `YYYY-MM-DD`, so the window bound is a string comparison — the same
  // `{ "items.k": { $gte: startKey } }` trick the download aggregates use, done inside a `$reduce`
  // here because the row must stay one row: `visitors` and `landedWithoutOpening` are counts *of
  // rows*, and an `$unwind` over the map would multiply them by the number of days each row holds.
  const startKey = start.toISOString().slice(0, 10);
  return [
    { $match: { ...match, ...activityWindowMatch(start) } },
    {
      // Nothing downstream reads `visitIdHashes`, and it is the one unbounded array on the row
      // (capped at `VISIT_ID_HASH_CAP`, but still hundreds of 64-char strings per viewer). Dropping
      // it at the head keeps the bytes that cross the aggregation out of the pipeline entirely.
      $project: {
        _id: 0,
        docsOpened: { $ifNull: ["$docsOpened", []] },
        windowLandings: {
          $let: {
            vars: { days: { $objectToArray: { $ifNull: ["$landingsByDay", {}] } } },
            in: {
              $cond: [
                // A row with no per-day history at all, **and** a lifetime `visits` that says it
                // arrived: written before `landingsByDay` existed, so it is in the window and
                // landed at least once in it. Claiming its whole lifetime `visits` is the bug this
                // replaced; claiming zero would contradict the visitor count beside it.
                //
                // The `visits` half of the test is not optional. A `ProjectLinkView` row is also
                // created by the ingest routes for a recipient who deep-links straight to
                // `/p/:shareId/:docId` and never touches the project page (POST
                // /api/share/:shareId/stats and GET /p/:shareId/:docId/pdf, both of which upsert the
                // row to record `docsOpened` and neither of which writes a landing). Without it
                // every such reader was a phantom landing — not once during a migration, but in
                // every window, forever: the dev corpus had a link whose row read `visits: 0`, no
                // session hashes and one document opened, and the tile answered "1 landing".
                {
                  $and: [{ $eq: [{ $size: "$$days" }, 0] }, { $gt: [{ $ifNull: ["$visits", 0] }, 0] }],
                },
                1,
                {
                  $reduce: {
                    input: "$$days",
                    initialValue: 0,
                    in: {
                      $add: ["$$value", { $cond: [{ $gte: ["$$this.k", startKey] }, { $ifNull: ["$$this.v", 0] }, 0] }],
                    },
                  },
                },
              ],
            },
          },
        },
      },
    },
    {
      $group: {
        _id: null,
        landings: { $sum: "$windowLandings" },
        // Rows that actually landed in the window, not every row the window matched. A row is
        // matched by *last activity*, which a deep-link reader moves without ever landing; counting
        // it here would put the phantom back through `readLandingRollup`'s `visitors` floor, and
        // would describe someone as having "landed without opening" who never landed.
        visitors: { $sum: { $cond: [{ $gt: ["$windowLandings", 0] }, 1, 0] } },
        landedWithoutOpening: {
          $sum: {
            $cond: [{ $and: [{ $gt: ["$windowLandings", 0] }, { $eq: [{ $size: "$docsOpened" }, 0] }] }, 1, 0],
          },
        },
      },
    },
  ];
}

/** {@link landingsPipeline}'s single row, coerced. An empty result is three zeroes, never `null`. */
export function readLandingRollup(rows: RawLandingRollup[] | null | undefined): LandingRollup {
  const row = Array.isArray(rows) ? rows[0] : undefined;
  const visitors = n0(row?.visitors);
  return {
    // A row written before `visits` existed still represents one arrival; never report fewer
    // landings than there were visitors, or the tile contradicts the list beneath it.
    landings: Math.max(n0(row?.landings), visitors),
    landedWithoutOpening: Math.min(n0(row?.landedWithoutOpening), visitors),
    visitors,
  };
}

// --- Per-document ranking ---------------------------------------------------------------------

/** One row of {@link byDocPipeline}, before titles are joined on. */
export type RawByDocRow = { docId?: unknown; viewers?: number; lastViewedAt?: Date | string | null };

/** A document inside the project, ranked by how many recipients opened it. */
export type ByDocRow = {
  docId: string;
  /** `null` when the document was deleted after the fact; its traffic still counts. */
  title: string | null;
  viewers: number;
  lastViewedAt: string | null;
};

/**
 * Documents opened inside one scope, ranked by recipients.
 *
 * Unlike `byLink`, this pipeline **does** follow `?shareId=`: "which files did *this* recipient
 * group open" is exactly the per-link question, where ranking the link the page is about against
 * its siblings is not. The route passes `scopeMatch` here and `projectScopeMatch` to the per-link
 * one, which is the whole difference between the two cards.
 *
 * `viewers` is a count of **(link, viewer) buckets that opened this document**, the same unit as
 * `totals.views` and `byLink[].viewers`, so the numbers on the page are all the same quantity. It
 * is deliberately not a distinct-people count across links: a person who opened the same file
 * through two links is two recipients everywhere else on this page, and one exception would make
 * the column stop adding up against the one above it.
 */
export function byDocPipeline(match: Record<string, unknown>, start: Date, limit: number): PipelineStage[] {
  return [
    { $match: { ...match, ...activityWindowMatch(start) } },
    {
      // One bucket per (document, link, viewer): counting rows instead would double a viewer who
      // has two rows for one document, which the composite-key ingest can produce after a link is
      // re-pointed. Grouping first makes the count mean people either way.
      $group: {
        _id: { docId: "$docId", viewer: PROJECT_LINK_VIEWER_KEY_EXPR },
        lastSeen: { $max: LAST_ACTIVITY_EXPR },
      },
    },
    { $group: { _id: "$_id.docId", viewers: { $sum: 1 }, lastViewedAt: { $max: "$lastSeen" } } },
    { $project: { _id: 0, docId: "$_id", viewers: 1, lastViewedAt: 1 } },
    // Rank in Mongo so what reaches Node stays flat however many documents the project holds.
    { $sort: { viewers: -1, lastViewedAt: -1 } },
    { $limit: Math.max(1, Math.floor(limit)) },
  ];
}

/**
 * Attach titles to {@link byDocPipeline}'s rows and drop anything unusable.
 *
 * A missing title is kept as `null` rather than dropped: the row is real traffic, and the card
 * renders it as "Deleted document" for exactly the reason the links card renders "Deleted link" —
 * the totals above include it, and a reader who cannot see why the list does not add up stops
 * trusting the page.
 */
export function shapeByDoc(rows: RawByDocRow[] | null | undefined, titles: Map<string, string>): ByDocRow[] {
  return (Array.isArray(rows) ? rows : [])
    .map((r) => {
      const docId = r?.docId == null ? "" : String(r.docId);
      const title = titles.get(docId);
      return {
        docId,
        title: typeof title === "string" && title.trim() ? title.trim() : null,
        viewers: n0(r?.viewers),
        lastViewedAt: r?.lastViewedAt ? new Date(r.lastViewedAt).toISOString() : null,
      };
    })
    .filter((r) => Boolean(r.docId))
    .sort((a, b) => b.viewers - a.viewers || (b.lastViewedAt ?? "").localeCompare(a.lastViewedAt ?? ""));
}

// --- Views by day -----------------------------------------------------------------------------

/**
 * The views-by-day series for a project scope, bucketed so the area under the chart equals
 * `totals.views`.
 *
 * Not shareable with the document route, and this is the one place the difference bites. A document
 * link's `ShareView` row **is** one (link, viewer) pair, carrying one activity date — so the
 * document series buckets rows directly by `ACTIVITY_DAY_KEY_EXPR` and the arithmetic closes. On a
 * project link one (link, viewer) owns one row *per document opened*, each with its own
 * `lastViewedAt`, so bucketing rows directly counts a recipient once per file.
 *
 * Hence two stages in this order, which is the whole content of this function: close the **viewer**
 * bucket first (taking the last activity across that viewer's documents), then bucket that single
 * date by day. Grouping on `{ day, viewer }` instead — the shape this shipped with — put a recipient
 * who read the deck on Monday and the term sheet on Wednesday into two day-buckets, and the chart
 * summed to 2 over a VIEWS tile that read 1. The seed data hid it only because one viewer happened
 * to read both files inside the same UTC day.
 *
 * The consequence to know: a viewer appears on the day they **last** read, not on every day they
 * read — exactly the rule the document chart already follows (see `ACTIVITY_DAY_KEY_EXPR`).
 */
export function viewsByDayPipeline(scopeMatch: Record<string, unknown>, start: Date): PipelineStage[] {
  return [
    { $match: { ...scopeMatch, ...activityWindowMatch(start) } },
    { $group: { _id: PROJECT_LINK_VIEWER_KEY_EXPR, lastSeen: { $max: LAST_ACTIVITY_EXPR } } },
    { $group: { _id: { $dateToString: { date: "$lastSeen", format: "%Y-%m-%d", timezone: "UTC" } }, views: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ] as PipelineStage[];
}
