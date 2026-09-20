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

/**
 * Separator between the viewer key and the document id in a project-link analytics row.
 *
 * `.` is not produced by either half (a sha256 hex digest and an ObjectId hex string), so the
 * composite splits unambiguously.
 */
export const PROJECT_VIEW_KEY_SEP = ".";

/**
 * The person at the head of a stored key, and the document behind it.
 *
 * The string form of the rule this file's expressions encode for Mongo, kept beside them and
 * deliberately free of imports: the realtime server is a standalone process with its own
 * `package.json` (see `realtime/Dockerfile`), and anything it imports must not drag a mongoose
 * model into that image. It lived in `share/projectPublic.ts`, which does, and the container
 * exited on `ERR_MODULE_NOT_FOUND` before `main()` ever ran. `projectPublic` re-exports these, so
 * every existing import keeps working and there is still one definition of the rule.
 */
export function splitProjectViewerKey(key: string): { botIdHash: string; docId: string | null } {
  const value = String(key ?? "");
  const at = value.indexOf(PROJECT_VIEW_KEY_SEP);
  if (at < 0) return { botIdHash: value, docId: null };
  return { botIdHash: value.slice(0, at), docId: value.slice(at + PROJECT_VIEW_KEY_SEP.length) || null };
}

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
