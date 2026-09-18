/**
 * Who a project-link analytics row belongs to (docs/METRICS.md, "Project links: how a data-room
 * visit is keyed").
 *
 * A project link is **one slug and N documents**, and the document lives inside the identity key:
 * `ShareView` is unique on `{shareId, botIdHash}`, so the ingest writes
 *
 *     botIdHash = "<sha256(botId)>" + "." + "<docId>"      // project links only
 *
 * rather than collapse three documents into one row and merge their page numbers. The composite is
 * deliberately recoverable — the first 64 characters are the viewer.
 *
 * The consequence for every project aggregate: grouping on `$botIdHash` counts **(viewer ×
 * document)**, not viewers. One investor reading a deck and a term sheet through the same link
 * reads as two recipients, and "5 people opened this" on a data room two people had opened is the
 * kind of number that loses a reader's trust in the whole page. These expressions are the
 * project-shaped replacements for `LINK_VIEWER_KEY_EXPR` in `../shareViewAggregates.ts`, which is
 * correct as it stands for document links and must not learn about this.
 */

/** The 64-character digest at the head of a project-link `botIdHash` — the browser, not the document. */
export const PROJECT_ANON_KEY_EXPR = { $substrCP: [{ $ifNull: ["$botIdHash", ""] }, 0, 64] } as const;

/**
 * A viewer within one project link: the signed-in user when there is one, otherwise the browser.
 *
 * Shaped exactly like `LINK_VIEWER_KEY_EXPR` (`{ shareId, viewer }`) so the two-stage
 * group/count-the-buckets pattern is the same on both routes and `sum(byLink[].viewers)` still
 * equals the project's own `viewerCount`.
 */
export const PROJECT_LINK_VIEWER_KEY_EXPR = {
  shareId: "$shareId",
  viewer: {
    $cond: [
      { $ne: [{ $ifNull: ["$viewerUserId", null] }, null] },
      { $concat: ["u:", { $toString: "$viewerUserId" }] },
      { $concat: ["a:", PROJECT_ANON_KEY_EXPR] },
    ],
  },
} as const;
