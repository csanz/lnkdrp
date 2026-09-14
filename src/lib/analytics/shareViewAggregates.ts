/**
 * Aggregation building blocks shared by the owner analytics routes.
 *
 * These live outside the route handlers for two reasons: the per-link and the document scope must
 * provably run the *same* arithmetic (only the `$match` differs), and the Mongo expressions below
 * have failure modes that are invisible at runtime — a bad reference yields `null`, the route's
 * defensive `?? {}` turns that into an empty object, and the UI renders a blank chip forever.
 * tests/lib/shareViewAggregates.test.ts pins the shapes that went wrong.
 */

/**
 * Merge an array of `{ "<page>": ms }` maps into one summed object.
 *
 * `mapsField` must name a field produced by an **earlier** stage (a `$push` in `$group`). This
 * used to read a sibling alias computed in the *same* `$project` stage
 * (`pageTimeItemsArrays: { $map: … }`, then `$reduce: { input: "$pageTimeItemsArrays" }`), and a
 * `$project` cannot see a field it is computing in that stage: the `$reduce` input resolved to
 * missing, `$arrayToObject` returned `null`, and every viewer's `pageTimeMsByPage` came back `{}`.
 * The per-page "Time on page" chips in the metrics viewer drawer were blank for every viewer, on
 * every link and on the document, while the stored rows held the right numbers all along.
 *
 * Keeping the `$objectToArray` inside the `$let` means there is only ever one stage, so the bug
 * cannot come back by someone re-merging the two projections.
 */
export function pageTimeMergeExpr(mapsField: string): Record<string, unknown> {
  if (!mapsField || mapsField.startsWith("$")) {
    throw new Error(`pageTimeMergeExpr expects a bare field name from an earlier stage, got "${mapsField}"`);
  }
  const maps = `$${mapsField}`;
  return {
    $let: {
      vars: {
        allItems: {
          $reduce: {
            input: {
              $map: {
                input: { $ifNull: [maps, []] },
                as: "m",
                in: { $objectToArray: { $ifNull: ["$$m", {}] } },
              },
            },
            initialValue: [],
            in: { $concatArrays: ["$$value", "$$this"] },
          },
        },
      },
      in: {
        $arrayToObject: {
          $map: {
            input: { $setUnion: [{ $map: { input: "$$allItems", as: "it", in: "$$it.k" } }, []] },
            as: "k",
            in: {
              k: "$$k",
              v: {
                $sum: {
                  $map: {
                    input: "$$allItems",
                    as: "it",
                    in: { $cond: [{ $eq: ["$$it.k", "$$k"] }, { $ifNull: ["$$it.v", 0] }, 0] },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

/**
 * The reference implementation of what {@link pageTimeMergeExpr} computes in Mongo, so the
 * contract ("sum the maps key by key, skipping non-numbers") is testable without a server.
 */
export function mergePageTimeMaps(maps: Array<Record<string, unknown> | null | undefined>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const map of maps ?? []) {
    if (!map || typeof map !== "object") continue;
    for (const [k, raw] of Object.entries(map)) {
      const v = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
      out[k] = (out[k] ?? 0) + v;
    }
  }
  return out;
}

/**
 * "Last real activity" on a `ShareView` / `ShareVisit` row.
 *
 * Not `updatedDate`: Mongoose stamps that on *any* update query, so a maintenance pass
 * (`scripts/sharelinks-analytics-backfill.ts`, the viewer-name backfill this route itself fires in
 * `after()`, a retention sweep) rewrote the entire "Last viewed" column to the instant the
 * maintenance ran — a link whose last real view was a week ago then printed "just now" the moment
 * an owner opened the metrics page. `lastViewedAt` is written only by the view ingest path, so
 * nothing but a view can move it; `updatedDate` remains the fallback for rows written before the
 * field existed, which self-heal on their owner's next visit.
 */
export const LAST_ACTIVITY_EXPR = { $ifNull: ["$lastViewedAt", "$updatedDate"] } as const;

/**
 * Which viewer a `ShareView` row belongs to, **within one link**.
 *
 * A viewer is counted once per link, not once per document: the same browser opening the Sequoia
 * link and the Accel link is two link-recipients. That is the definition that keeps the document
 * figure equal to the sum of its links' figures — the invariant every card on the metrics page
 * relies on, since the per-link table sits directly under the "All links" tiles and readers add
 * the column up. Counting distinct people at the document level made the tile say "3 people" over
 * a table summing to 4, with nothing on the page to explain the gap.
 */
export const LINK_VIEWER_KEY_EXPR = {
  shareId: "$shareId",
  viewer: {
    $cond: [
      { $ne: [{ $ifNull: ["$viewerUserId", null] }, null] },
      { $concat: ["u:", { $toString: "$viewerUserId" }] },
      { $concat: ["a:", { $ifNull: ["$botIdHash", ""] }] },
    ],
  },
} as const;

/** Start of the UTC day `days - 1` days ago: the inclusive lower bound of every window. */
export function windowStartUtc(days: number, now: Date = new Date()): Date {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (Math.max(1, Math.floor(days)) - 1));
  return start;
}
