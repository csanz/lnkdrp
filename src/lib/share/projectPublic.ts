/**
 * The recipient-facing half of project links: what `/p/:shareId` and `/p/:shareId/:docId` are
 * allowed to show, and how a visit behind a project link is keyed in the analytics collections
 * (docs/prds/lnkdrp-project-links.md, milestone M2).
 *
 * Kept apart from `./projectLinks.ts` (the owner-facing CRUD service) for the same reason that file
 * is kept apart from `./links.ts`: everything here runs on a **public, unauthenticated** request, so
 * "which rows can a recipient reach" is a question you answer by reading one file. Nothing in here
 * takes an `orgId` from a caller; tenancy is always derived from the slug.
 *
 * Two rules live here and nowhere else:
 *
 * 1. **A document is reachable through a project link only if it is in that project right now.**
 *    Membership is re-checked on every request — the page render, the viewer render, the PDF proxy
 *    and the stats ingest all call {@link findProjectDocument} — rather than trusted from a URL or
 *    a request body. `/api/metrics/events` learned this the expensive way: resolving an
 *    attacker-supplied slug and then writing against whatever it named performed writes in a
 *    foreign workspace. It also settles the PRD's open question about removal: contents are
 *    resolved per request, so a document taken out of the project disappears immediately.
 *
 * 2. **How a project-link visit is keyed.** See {@link projectViewerKey}.
 */
import { Types } from "mongoose";

import { PROJECT_VIEW_KEY_SEP } from "@/lib/analytics/project/viewerKey";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { isExpired } from "./links";
import { resolveProjectLink, type ProjectLike, type ResolvedProjectLink } from "./projectLinks";

/**
 * The separator and the split live in `analytics/project/viewerKey`, which has no imports.
 *
 * They are re-exported here because this is where they were and where the rule is documented, and
 * because the realtime server — a standalone process with its own dependency list — needs the
 * split without this module's mongoose models coming with it.
 */
export { PROJECT_VIEW_KEY_SEP, splitProjectViewerKey } from "@/lib/analytics/project/viewerKey";

/**
 * The `botIdHash` a project-link `ShareView` / `ShareVisit` row is written under.
 *
 * A project link has one `shareId` and N documents, and a recipient reading three of them must
 * produce three rows — one per document — or their pages and their reading time merge into a single
 * page-number namespace (page 3 of the term sheet adding time to page 3 of the deck). The natural
 * fix is a `docId` in the unique keys, `{shareId, botIdHash, docId}`. Those indexes live in
 * `ShareView.ts` / `ShareVisit.ts`, which this milestone does not own, so the same compound is
 * expressed inside the field the key already has:
 *
 *     botIdHash = "<sha256(botId)>" + "." + "<docId>"
 *
 * It is a composite, not a hash of a composite, on purpose: the viewer is still recoverable from
 * the stored value (`splitProjectViewerKey`, or a `^<botIdHash>\.` prefix match), so "how many
 * people came through this link" stays answerable without a second collection, and the activity
 * feed's `viewerKey` join keeps finding the row it names.
 *
 * Consequences, written down here and in docs/METRICS.md because M4 depends on them:
 * - Under a project link, `ShareView` rows count **(viewer × document opened)**, not viewers.
 *   Views for a project link are `ProjectLinkView` row count, or `distinct` on the key prefix —
 *   never `countDocuments({ shareId })`.
 * - Under a project link, `ShareVisit` rows count (tab session × document). The `visitId` is stored
 *   per `shareId` in `sessionStorage`, so one tab reading two documents shares a `visitIdHash`
 *   across both rows: "one session in the data room, one row per document in it".
 * - Per-**document** figures are unaffected: for a given `docId` a viewer still has exactly one row
 *   per link, which is what the document metrics page already assumes.
 *
 * Document links are untouched: their rows keep a bare 64-character digest.
 */
export function projectViewerKey(botIdHash: string, docId: string | Types.ObjectId): string {
  return `${botIdHash}${PROJECT_VIEW_KEY_SEP}${String(docId)}`;
}

/**
 * The Mongo `$or` clause for **every row one person owns**: the bare digest a document link writes,
 * and any project key that starts with it.
 *
 * It exists as a function because writing it inline got it wrong twice. The pattern needs a literal
 * backslash before an interpolation — `` `^${key}\\${SEP}` `` — and one backslash instead of two
 * escapes the `$`, turning the whole thing into the literal text "${PROJECT_VIEW_KEY_SEP}" with a
 * stray end-anchor in front of it. That matches nothing, silently: no error, no empty result to
 * notice, just an identity that never propagates to the rows read inside a data room. Built here,
 * once, and asserted in tests/lib/projectPublic.test.ts.
 *
 * A key that is not a 64-character hex digest is matched exactly rather than interpolated into a
 * pattern: these values are read back out of stored documents.
 */
export function viewerKeyMatchClause(viewerKey: string): Array<Record<string, unknown>> {
  if (!/^[a-f0-9]{64}$/.test(viewerKey)) return [{ botIdHash: viewerKey }];
  return [{ botIdHash: viewerKey }, { botIdHash: { $regex: viewerKeyPrefixPattern(viewerKey) } }];
}

/** The `^<digest>\.` pattern on its own, so a test can look at it without a Mongo clause around it. */
export function viewerKeyPrefixPattern(viewerKey: string): string {
  // Concatenation, not a template literal: the escaping that broke this twice cannot recur here.
  return "^" + viewerKey + "\\" + PROJECT_VIEW_KEY_SEP;
}


/** The fields the public project page and the document cards on it render. */
export const PROJECT_DOC_LIST_FIELDS = {
  _id: 1,
  shareId: 1,
  title: 1,
  docName: 1,
  fileName: 1,
  previewImageUrl: 1,
  firstPagePngUrl: 1,
  "aiOutput.one_liner": 1,
  "aiOutput.summary": 1,
  "aiOutput.meta_description": 1,
  "aiOutput.openGraph.description": 1,
  updatedDate: 1,
  createdDate: 1,
} as const;

/**
 * The membership filter — the single definition of "in this project, right now".
 *
 * `projectId` **or** `projectIds`: a document can belong to several projects at once, which is the
 * reason the product calls these Projects and not Folders (PRD, "Naming").
 *
 * `shareEnabled: { $ne: false }` stays. PRD decision 3 hands the project link authority over
 * password, expiry and download — the settings that describe *this audience* — but the document's
 * own share switch answers a different question ("is this document shared at all"), and an owner
 * who switched a document off did not ask for it to keep going out inside a data room. Legacy rows
 * without the field are on, as everywhere else.
 */
function projectDocFilter(project: ProjectLike): Record<string, unknown> {
  return {
    ...(project.orgId ? { orgId: project.orgId } : null),
    isDeleted: { $ne: true },
    isArchived: { $ne: true },
    shareEnabled: { $ne: false },
    $or: [{ projectId: project._id }, { projectIds: project._id }],
  };
}

export type PublicProjectDoc = {
  _id: Types.ObjectId;
  shareId?: string | null;
  title?: string | null;
  docName?: string | null;
  fileName?: string | null;
  previewImageUrl?: string | null;
  firstPagePngUrl?: string | null;
  aiOutput?: unknown;
} & Record<string, unknown>;

/** The project's current, non-archived documents, newest activity first. */
export async function listProjectDocuments(project: ProjectLike, opts: { select?: Record<string, 1> } = {}): Promise<PublicProjectDoc[]> {
  await connectMongo();
  return (await DocModel.find(projectDocFilter(project))
    .select({ ...PROJECT_DOC_LIST_FIELDS, ...(opts.select ?? {}) })
    .sort({ updatedDate: -1, createdDate: -1 })
    .lean()) as unknown as PublicProjectDoc[];
}

/**
 * One document of a project, by id — or null when it is not (or is no longer) in the project.
 *
 * The same filter as the list above, so "visible on the project page" and "openable through the
 * project link" can never disagree. A malformed id is a miss rather than a cast error, because this
 * runs on a public route where the id comes straight out of the URL.
 */
export async function findProjectDocument(
  project: ProjectLike,
  docId: string | Types.ObjectId,
  opts: { select?: Record<string, 1> } = {},
): Promise<PublicProjectDoc | null> {
  const id = String(docId).trim();
  if (!id || !Types.ObjectId.isValid(id)) return null;
  await connectMongo();
  return (await DocModel.findOne({ _id: new Types.ObjectId(id), ...projectDocFilter(project) })
    .select({ ...PROJECT_DOC_LIST_FIELDS, ...(opts.select ?? {}) })
    .lean()) as unknown as PublicProjectDoc | null;
}

export type ResolvedProjectDocument = ResolvedProjectLink & {
  /**
   * The document being read, already proven to be a live member of the link's project — **unless
   * `refusal` is set**, in which case it is {@link REFUSED_LINK_DOC} and says nothing about the
   * room. Read `refusal` first; every caller already does, because a refused link renders a notice
   * and stops.
   */
  doc: PublicProjectDoc;
};

/**
 * The stand-in document a refused link answers with.
 *
 * It carries no field from any stored row, and the zero id is not a document that exists anywhere —
 * it is a placeholder that keeps {@link ResolvedProjectDocument} one shape rather than two, so no
 * caller outside this file has to change to get the refusal path right.
 */
const REFUSED_LINK_DOC: PublicProjectDoc = Object.freeze({ _id: new Types.ObjectId("000000000000000000000000") });

/**
 * Resolve `/p/:shareId/:docId` in one call: the project link, its refusal state, and the document —
 * or null when the slug is not a project link's, or the document is not in that project.
 *
 * Returning null for a non-member document rather than a refusal is deliberate: a recipient must
 * not be able to learn that a document id exists somewhere else in the workspace by watching the
 * shape of the answer.
 *
 * A refused link answers the same way for every id, member or not — see the branch below.
 */
export async function resolveProjectDocument(
  shareId: string,
  docId: string,
  opts: { select?: Record<string, 1>; projectSelect?: Record<string, 1> } = {},
): Promise<ResolvedProjectDocument | null> {
  const resolved = await resolveProjectLink(shareId, { select: opts.projectSelect });
  if (!resolved) return null;
  /**
   * A refused link is refused for every id it is handed, and the room is not asked anything.
   *
   * This branch used to promise exactly that in a comment and then do the opposite: it looked the
   * document up and returned `null` on a miss — the same `null` that means "this slug is not a
   * project link at all". Callers act on that difference (a refusal notice versus a 404, a 404
   * versus the quiet 200 a locked link answers with), so an expired or disabled link — which a
   * stranger may well be holding, since expiry is what happens to a forwarded link — became a
   * membership oracle: walk candidate ids, and the two answers spell out the room's contents. The
   * refusal is a property of the link, not of what is behind it.
   *
   * So the lookup is gone: no query, no timing difference, the same object for every id. What the
   * caller needed from here it already has (`link`, `project`, `refusal`); `doc` is the placeholder.
   */
  if (resolved.refusal) return { ...resolved, doc: REFUSED_LINK_DOC };
  const doc = await findProjectDocument(resolved.project, docId, { select: opts.select });
  if (!doc) return null;
  return { ...resolved, doc };
}

/**
 * Recover the document a project-link analytics POST is about, from the page that sent it.
 *
 * The share viewer posts to `/api/share/:shareId/stats` and names no document — it never had to,
 * because a document link's slug *is* the document. A project link's slug is not, so the pair has
 * to be reassembled somewhere. The body would be the obvious place, except that filling it in means
 * a new prop through `PdfJsViewer`, a component this milestone does not own; so the route derives
 * it instead, from the one thing the browser already sends for free: the `Referer`, which for a
 * same-origin request is the full path under this app's
 * `Referrer-Policy: strict-origin-when-cross-origin`.
 *
 * Trusting a header would be indefensible if it decided *access*. It does not. The value is only a
 * claim about which of this link's documents is being read, and `findProjectDocument` re-proves
 * membership before anything is written, so the worst a forged referer can do is attribute a view
 * to another document the same recipient can already open through the same link. The `shareId`
 * guard below rejects a referer from a different link outright.
 *
 * Returns null for anything that is not a `/p/:shareId/:docId` page, which is how a document link's
 * POST — and a stray probe — falls through to the document path untouched.
 */
export function projectDocIdFromReferer(referer: string | null | undefined, shareId: string): string | null {
  if (!referer) return null;
  let pathname: string;
  try {
    pathname = new URL(referer).pathname;
  } catch {
    return null;
  }
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "p") return null;
  const safe = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  if (safe(parts[1]) !== shareId) return null;
  const docId = safe(parts[2]).trim();
  return docId && Types.ObjectId.isValid(docId) ? docId : null;
}

/**
 * The project-link half of the stats/overlay ingest: which link, which project, which document.
 *
 * Takes the document id the caller put in the body when it has one (a viewer that learns to send it
 * later needs no server change) and falls back to {@link projectDocIdFromReferer}. Null when the
 * slug is not a project link's, or no document can be named, or the named one is not in the project.
 */
export async function resolveProjectStatsTarget(input: {
  shareId: string;
  request: Request;
  bodyDocId?: unknown;
  select?: Record<string, 1>;
}): Promise<ResolvedProjectDocument | null> {
  const fromBody = typeof input.bodyDocId === "string" && input.bodyDocId.trim() ? input.bodyDocId.trim() : null;
  const docId = fromBody ?? projectDocIdFromReferer(input.request.headers.get("referer"), input.shareId);
  if (!docId) return null;
  return resolveProjectDocument(input.shareId, docId, { select: input.select });
}

/** Whether a project link is password protected (both halves of the material present). */
export function projectLinkPasswordEnabled(link: { passwordHash?: string | null; passwordSalt?: string | null }): boolean {
  return typeof link.passwordHash === "string" && Boolean(link.passwordHash) && typeof link.passwordSalt === "string" && Boolean(link.passwordSalt);
}

/**
 * Re-export so `/p/**` never has to reach into `./links.ts` for the expiry rule and risk growing a
 * second, subtly different one.
 */
export { isExpired };
