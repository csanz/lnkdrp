/**
 * Share links service — the one place that creates, lists, updates, resolves and counts the
 * links of a document (docs/prds/lnkdrp-multi-links.md).
 *
 * Rules enforced here, so routes, the MCP and scripts cannot disagree:
 * - `resolveShareLink(shareId)` is the only way a public share route turns a slug into a
 *   document, and it materialises the default link for pre-model documents on first touch.
 * - Everything here is about **document** links. `ShareLink` also stores project links
 *   (`src/lib/share/projectLinks.ts`, docs/prds/lnkdrp-project-links.md), which have no `docId`;
 *   every query below either pins an ObjectId `docId` (which excludes them on its own, since
 *   theirs is null) or carries `DOC_LINK_FILTER`. Nothing in this file may return a project link.
 * - The Free cap counts shared *documents*, never links: a document may own any number of links,
 *   workspace. Links themselves are never plan-capped — see `createShareLink`.
 * - `Doc.shareEnabled` is kept equal to "the document has at least one enabled link", and the
 *   default link's settings are mirrored onto the legacy Doc fields for one release, so older
 *   readers and the rollback build keep working.
 */
import { cache } from "react";
import { Types, type ProjectionType } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { DOC_LINK_FILTER, ShareLinkModel, type ShareLink, type ShareLinkKind } from "@/lib/models/ShareLink";
import { ShareViewModel } from "@/lib/models/ShareView";
import { ensurePersonalOrgForUserId } from "@/lib/models/Org";
import { newShareId } from "@/lib/crypto/randomBase62";
import { encryptSharePassword, hashSharePassword, shareAuthCookieName, shareAuthCookieValue } from "@/lib/sharePassword";
import { checkLimit, type LimitCheck } from "@/lib/billing/planLimits";
import { SHARE_PASSWORD_MIN, SHARE_PASSWORD_MAX } from "./passwordPolicy";
import { shareAuthCookieMatches } from "./cookieCompare";

export const SHARE_LINK_LABEL_MAX = 80;
export const SHARE_LINK_AUDIENCE_MAX = 120;
export const SHARE_LINKS_PER_DOC_MAX = 50;
export { SHARE_PASSWORD_MIN, SHARE_PASSWORD_MAX } from "./passwordPolicy";
export const DEFAULT_LINK_LABEL = "Default link";

export type ShareLinkDTO = {
  id: string;
  /** Null on a project link. Document routes only ever hand back rows where this is set. */
  docId: string | null;
  /** Set only on a project link (`src/lib/share/projectLinks.ts`). */
  projectId: string | null;
  kind: ShareLinkKind;
  shareId: string;
  label: string;
  audience: string | null;
  isDefault: boolean;
  enabled: boolean;
  allowDownload: boolean;
  allowRevisionHistory: boolean;
  passwordEnabled: boolean;
  expiresAt: string | null;
  /** Derived: enabled, not archived, not expired. */
  active: boolean;
  status: "active" | "disabled" | "expired" | "archived";
  createdVia: string;
  createdAt: string;
  lastViewedAt: string | null;
  viewCount: number;
  downloadCount: number;
};

/** Field shape the service needs from a Doc (lean or hydrated). */
type DocLike = {
  _id: Types.ObjectId;
  orgId?: Types.ObjectId | null;
  userId?: Types.ObjectId | null;
  shareId?: string | null;
  shareEnabled?: boolean | null;
  shareAllowPdfDownload?: boolean | null;
  shareAllowRevisionHistory?: boolean | null;
  sharePasswordSalt?: string | null;
  sharePasswordHash?: string | null;
  sharePasswordEnc?: string | null;
  sharePasswordEncIv?: string | null;
  sharePasswordEncTag?: string | null;
  isDeleted?: boolean | null;
  isArchived?: boolean | null;
};

const DOC_SHARE_FIELDS = {
  _id: 1,
  orgId: 1,
  userId: 1,
  shareId: 1,
  shareEnabled: 1,
  shareAllowPdfDownload: 1,
  shareAllowRevisionHistory: 1,
  sharePasswordSalt: 1,
  sharePasswordHash: 1,
  sharePasswordEnc: 1,
  sharePasswordEncIv: 1,
  sharePasswordEncTag: 1,
  isDeleted: 1,
  isArchived: 1,
} as const;

function oid(v: string | Types.ObjectId): Types.ObjectId {
  return v instanceof Types.ObjectId ? v : new Types.ObjectId(v);
}

/** Past its `expiresAt` instant. Exported for `./projectLinks.ts`, which applies the same rule. */
export function isExpired(link: Pick<ShareLink, "expiresAt">, now = Date.now()): boolean {
  return Boolean(link.expiresAt && link.expiresAt.getTime() <= now);
}

/** Enabled, not archived, not expired. */
export function isLinkActive(link: Pick<ShareLink, "enabled" | "archivedAt" | "expiresAt">, now = Date.now()): boolean {
  return Boolean(link.enabled) && !link.archivedAt && !isExpired(link, now);
}

/** The password material a link carries; both halves are needed for the gate to be on. */
export type PasswordProtectedLink = { passwordHash?: string | null; passwordSalt?: string | null };

/** Whether this link asks for a password at all (both halves of the scrypt material present). */
export function shareLinkPasswordEnabled(link: PasswordProtectedLink | null | undefined): boolean {
  if (!link) return false;
  return (
    typeof link.passwordHash === "string" &&
    Boolean(link.passwordHash) &&
    typeof link.passwordSalt === "string" &&
    Boolean(link.passwordSalt)
  );
}

/** One cookie off a raw request. The share-auth value is opaque base64url and needs no decoding. */
function readCookie(request: Request, name: string): string {
  const raw = request.headers.get("cookie");
  if (!raw) return "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=") || "";
  }
  return "";
}

/**
 * Has this request passed the link's password gate?
 *
 * A password on a link is the owner saying **the URL is not enough**: the slug travels in inboxes,
 * Slack channels, browser histories and referrers, and the password is the only thing that makes
 * forwarding it harmless. That promise holds only if every path to the document asks, and one did
 * not. `/s/:shareId`, its PDF proxy and the revision-history route each carry their own copy of the
 * check; the download-request chain — a third way to the same bytes — carried none. Anyone holding
 * a protected slug could file a download request, have the owner approve it (the mail names a
 * document they did share and an address the requester chose, and says nothing about a gate), then
 * claim the PDF and a permanent copy of it through `/api/download/:token/*`.
 *
 * So the rule lives here and those routes call it: **a protected link answers nothing — not the
 * document, not a request about it, not its download setting — to a caller who has not entered the
 * password.** Being signed in is no substitute, and neither is the owner's approval: an approval is
 * permission for a person, the password is permission for a browser, and an owner who adds or
 * rotates one is cutting off everyone who has not typed the new one.
 *
 * True when the link has no password, so a caller can ask unconditionally and cannot acquire the
 * bug by forgetting the `if`. The cookie is set by `POST /api/share/:shareId/unlock` and is an HMAC
 * over the stored hash, so it dies on its own when the password changes — no revocation list, and
 * no way to mint one without knowing the password.
 */
export function shareLinkUnlocked(request: Request, shareId: string, link: PasswordProtectedLink): boolean {
  if (!shareLinkPasswordEnabled(link)) return true;
  const cookie = readCookie(request, shareAuthCookieName(shareId));
  return shareAuthCookieMatches(cookie, shareAuthCookieValue({ shareId, sharePasswordHash: String(link.passwordHash) }));
}

/**
 * Recomputed traffic for one link, from the analytics rows.
 *
 * `ShareLink.viewCount` / `downloadCount` / `lastViewedAt` are denormalized counters, and a counter
 * and a row count drift: the owner-preview pass reclassified rows that the counters had already
 * counted, so `/links` reported 4 views and a 02:03:16 last view for a link whose analytics said 3
 * and 02:02:56. Two surfaces of the same product disagreeing about one link is worse than either
 * being slightly stale, so the rows win wherever they are available.
 */
export type ShareLinkStats = { viewCount: number; downloadCount: number; lastViewedAt: Date | null };

/**
 * Recompute every link's traffic for one document, in one aggregation.
 *
 * Recipients only (`isOwnerPreview: { $ne: true }`) and `lastViewedAt` before `updatedDate`, which
 * are the same two rules the metrics route runs — so the links table and the metrics page cannot
 * report different numbers for the same link.
 */
export async function shareLinkStatsByShareId(docId: string | Types.ObjectId, shareIds?: string[]): Promise<Map<string, ShareLinkStats>> {
  await connectMongo();
  const rows = (await ShareViewModel.aggregate([
    // `shareIds`, when given, narrows the aggregate to one page of links instead of every link the
    // document has ever had traffic on — the same reasoning as `listShareLinksPage` above it.
    { $match: { docId: oid(docId), isOwnerPreview: { $ne: true }, ...(shareIds?.length ? { shareId: { $in: shareIds } } : {}) } },
    {
      $group: {
        _id: "$shareId",
        viewCount: { $sum: 1 },
        downloadCount: { $sum: { $ifNull: ["$downloads", 0] } },
        lastViewedAt: { $max: { $ifNull: ["$lastViewedAt", "$updatedDate"] } },
      },
    },
  ])) as Array<{ _id: string; viewCount?: number; downloadCount?: number; lastViewedAt?: Date | null }>;
  const out = new Map<string, ShareLinkStats>();
  for (const r of rows) {
    if (typeof r._id !== "string" || !r._id) continue;
    out.set(r._id, {
      viewCount: typeof r.viewCount === "number" && Number.isFinite(r.viewCount) ? r.viewCount : 0,
      downloadCount: typeof r.downloadCount === "number" && Number.isFinite(r.downloadCount) ? r.downloadCount : 0,
      lastViewedAt: r.lastViewedAt ? new Date(r.lastViewedAt) : null,
    });
  }
  return out;
}

/**
 * @param stats Recomputed traffic from {@link shareLinkStatsByShareId}. When omitted the link's own
 * counters are used, which is right for a link that has just been created or edited and has no
 * rows yet — and wrong, slowly, for anything the owner reads more than once.
 */
export function toShareLinkDTO(link: ShareLink, stats?: ShareLinkStats | null): ShareLinkDTO {
  const status: ShareLinkDTO["status"] = link.archivedAt ? "archived" : !link.enabled ? "disabled" : isExpired(link) ? "expired" : "active";
  return {
    id: String(link._id),
    // `String(undefined)` is the string "undefined", which a client cannot tell from an id — hence
    // the explicit null for a link that has no document.
    docId: link.docId ? String(link.docId) : null,
    projectId: link.projectId ? String(link.projectId) : null,
    kind: link.projectId ? "project" : "doc",
    shareId: link.shareId,
    label: link.label,
    audience: link.audience ?? null,
    isDefault: Boolean(link.isDefault),
    enabled: Boolean(link.enabled),
    allowDownload: Boolean(link.allowDownload),
    allowRevisionHistory: Boolean(link.allowRevisionHistory),
    passwordEnabled: Boolean(link.passwordHash),
    expiresAt: link.expiresAt ? link.expiresAt.toISOString() : null,
    active: status === "active",
    status,
    createdVia: link.createdVia ?? "web",
    createdAt: link.createdDate ? link.createdDate.toISOString() : new Date(0).toISOString(),
    // A link with no analytics rows reports zero rather than its counter: the rows are the
    // recomputable truth, and a link whose rows were swept is genuinely a link with no traffic.
    lastViewedAt: stats ? (stats.lastViewedAt ? stats.lastViewedAt.toISOString() : null) : link.lastViewedAt ? link.lastViewedAt.toISOString() : null,
    viewCount: stats ? stats.viewCount : link.viewCount ?? 0,
    downloadCount: stats ? stats.downloadCount : link.downloadCount ?? 0,
  };
}

/**
 * Materialise the default link for a document that predates the model, copying its share
 * settings. Idempotent: the unique `shareId` index makes a concurrent double-create a no-op.
 *
 * Null when the document has neither a workspace nor an owner to hang the link on — see
 * {@link ensureDefaultLink}, the throwing wrapper every org-scoped caller uses. Only the public
 * resolve below can meet such a document, and its answer is a miss, not an error.
 */
async function ensureDefaultLinkOrNull(doc: DocLike, opts: { createdVia?: "web" | "api" | "mcp" } = {}): Promise<ShareLink | null> {
  await connectMongo();
  const existing = await ShareLinkModel.findOne({ docId: doc._id, isDefault: true }).lean<ShareLink>();
  if (existing) return existing;
  // `ShareLink.orgId` is `required: true`, so a document that predates workspaces — no `orgId`,
  // only a `userId`, which is exactly the row `buildDocMatch`'s `allowLegacyByUserId` exists to
  // serve and the one `scripts/sharelinks-backfill.ts` deliberately skips — used to make this a
  // *throw* rather than a backfill: `create` was rejected by the required field, the catch below
  // found no row to fall back on and rethrew, and the throw came out of `resolveShareLink` as the
  // error boundary on the public `/s/:shareId`. The recipient's link was neither served nor
  // refused. Adopt the document into its owner's personal workspace instead and write the id back
  // so it happens once — the same move `ensureDefaultProjectLink` makes for `/p/:shareId`.
  let orgId = doc.orgId ?? null;
  if (!orgId && doc.userId) {
    try {
      orgId = (await ensurePersonalOrgForUserId({ userId: oid(doc.userId) })).orgId;
      await DocModel.updateOne({ _id: doc._id }, { $set: { orgId } });
    } catch {
      orgId = null;
    }
  }
  // Nothing to adopt it into (no owner either): hand back nothing rather than throw, so the caller
  // treats the slug as a miss instead of 500-ing on it.
  if (!orgId) return null;
  let shareId = (doc.shareId && String(doc.shareId).trim()) || newShareId();
  const byShareId = await ShareLinkModel.findOne({ shareId }).lean<ShareLink>();
  // `Doc.shareId` and `Project.shareId` are unique in their own collections but not against each
  // other, so a legacy `Doc.shareId` can collide with a project link's slug. Taking a fresh slug is
  // the only safe answer: the unique index would refuse the insert, and adopting the project's row
  // as this document's default link would point `/s/` at the wrong thing.
  if (byShareId && byShareId.projectId) shareId = newShareId();
  else if (byShareId) return byShareId;
  try {
    const created = await ShareLinkModel.create({
      orgId,
      docId: doc._id,
      shareId,
      label: DEFAULT_LINK_LABEL,
      audience: null,
      isDefault: true,
      enabled: doc.shareEnabled !== false,
      // Born off *because the document is off* — which is the document switch having disabled it,
      // and is why the marker is set here. Without it this row looks exactly like a link the sender
      // revoked by hand, and `setAllLinksEnabled` must never restore one of those: the two are told
      // apart by this field alone.
      disabledByDocSwitch: doc.shareEnabled === false,
      allowDownload: Boolean(doc.shareAllowPdfDownload),
      allowRevisionHistory: Boolean(doc.shareAllowRevisionHistory),
      expiresAt: null,
      passwordSalt: doc.sharePasswordSalt ?? null,
      passwordHash: doc.sharePasswordHash ?? null,
      passwordEnc: doc.sharePasswordEnc ?? null,
      passwordEncIv: doc.sharePasswordEncIv ?? null,
      passwordEncTag: doc.sharePasswordEncTag ?? null,
      createdByUserId: doc.userId ?? null,
      // Only the document create route knows who made it; every lazy backfill is a migration.
      createdVia: opts.createdVia ?? "migration",
    });
    // Backfill (or, after the slug collision above, re-point) `Doc.shareId` at its default link.
    if (doc.shareId !== shareId) await DocModel.updateOne({ _id: doc._id }, { $set: { shareId } });
    return created.toObject() as ShareLink;
  } catch (e) {
    // Lost a race on the unique index: return whichever row won.
    const again = await ShareLinkModel.findOne({ $or: [{ shareId }, { docId: doc._id, isDefault: true }] }).lean<ShareLink>();
    if (again) return again;
    throw e;
  }
}

/**
 * {@link ensureDefaultLinkOrNull} for the callers that already hold an org-scoped document and so
 * cannot be handed a null: every route and script here reached the document through a workspace or
 * its owner, which means the adoption above always finds one, and a document with neither is a
 * corrupt row rather than a case to branch on. Kept non-null so those call sites stay unchanged.
 *
 * The public slug is the one caller that can genuinely meet a document with no owner at all, and it
 * uses the nullable form — a stranger gets a 404, never a 500.
 */
export async function ensureDefaultLink(doc: DocLike, opts: { createdVia?: "web" | "api" | "mcp" } = {}): Promise<ShareLink> {
  const link = await ensureDefaultLinkOrNull(doc, opts);
  if (!link) throw new ShareLinkError("not_found", "This document has no workspace or owner to attach a link to.");
  return link;
}

export type ResolvedShareLink = {
  link: ShareLink;
  doc: DocLike & Record<string, unknown>;
  /** Why a public route must refuse, or null when the link may be served. */
  refusal: null | "disabled" | "expired" | "archived" | "doc_gone";
};

/**
 * Turn a public slug into its link and document. Falls back to `Doc.shareId` for documents that
 * have no link row yet (and creates their default link). Returns null when nothing matches — and
 * also when a matching document has no workspace to hang a link on, which is a miss rather than an
 * error. The caller decides what to do with `refusal` (share routes answer 404).
 */
export async function resolveShareLink(shareId: string, opts: { select?: Record<string, 1> } = {}): Promise<ResolvedShareLink | null> {
  const slug = (shareId || "").trim();
  if (!slug) return null;
  await connectMongo();
  let link = await ShareLinkModel.findOne({ shareId: slug }).lean<ShareLink>();
  // A project link lives in the same slug namespace but has no document: `/s/:shareId` and every
  // caller below it must refuse it outright. Without this the `DocModel.findOne({ _id: null })`
  // underneath returns nothing and the slug reports `refusal: "doc_gone"` — a 404 either way, but
  // one that reads as "the document was deleted" in logs and in the download-token paths.
  // `/p/:shareId` resolves these, via `resolveProjectLink()` in `src/lib/share/projectLinks.ts`.
  if (link?.projectId) return null;
  let doc: (DocLike & Record<string, unknown>) | null = null;
  if (link) {
    doc = (await DocModel.findOne({ _id: link.docId })
      .select({ ...DOC_SHARE_FIELDS, ...(opts.select ?? {}) })
      .lean()) as (DocLike & Record<string, unknown>) | null;
  } else {
    doc = (await DocModel.findOne({ shareId: slug })
      .select({ ...DOC_SHARE_FIELDS, ...(opts.select ?? {}) })
      .lean()) as (DocLike & Record<string, unknown>) | null;
    if (!doc) return null;
    // A deleted legacy document is a miss, not a reason to materialise a link for it. This is an
    // anonymous GET, and it used to adopt the row into a workspace, create its default link and
    // write `Doc.shareId` back before noticing the document was gone.
    if (doc.isDeleted) return null;
    link = await ensureDefaultLinkOrNull(doc);
    // No link could be materialised (a document with neither workspace nor owner). The slug is
    // real but there is nothing to serve it with, so this is a 404, never a 500 — the same answer
    // `resolveProjectLink` gives for the project-shaped version of this row.
    if (!link) return null;
  }
  if (!doc || doc.isDeleted) return link ? { link, doc: doc ?? ({ _id: link.docId } as DocLike & Record<string, unknown>), refusal: "doc_gone" } : null;
  const refusal: ResolvedShareLink["refusal"] = doc.isArchived
    ? "archived"
    : link.archivedAt
      ? "archived"
      : !link.enabled
        ? "disabled"
        : isExpired(link)
          ? "expired"
          : null;
  return { link, doc, refusal };
}

/**
 * The fields the `/s/:shareId` page tree needs, as one projection: the layout's refusal check, the
 * metadata's title and description, the page's viewer and AI snapshot fields.
 */
export const SHARE_PAGE_SELECT: Record<string, 1> = {
  title: 1,
  blobUrl: 1,
  orgId: 1,
  "aiOutput.meta_title": 1,
  "aiOutput.meta_description": 1,
  "aiOutput.openGraph.title": 1,
  "aiOutput.openGraph.description": 1,
  "aiOutput.one_liner": 1,
  "aiOutput.core_problem_or_need": 1,
  "aiOutput.primary_capabilities_or_scope": 1,
  "aiOutput.intended_use_or_context": 1,
  "aiOutput.outcomes_or_value": 1,
  "aiOutput.maturity_or_status": 1,
  "aiOutput.summary": 1,
  "aiOutput.company_or_project_name": 1,
  "aiOutput.category": 1,
  "aiOutput.tags": 1,
  "aiOutput.key_metrics": 1,
  "aiOutput.ask": 1,
  receiverRelevanceChecklist: 1,
  previewImageUrl: 1,
  firstPagePngUrl: 1,
};

/**
 * {@link resolveShareLink} for the `/s/:shareId` page tree, memoised per request.
 *
 * The layout, `generateMetadata` and the page each resolved the same slug with their own
 * projection, so one public page render read the link and the document three times (and once
 * more in the metadata). `React.cache` keys on the argument, so all three now share one read as
 * long as they ask for the same thing; `SHARE_PAGE_SELECT` is the union of what they asked for.
 * Routes (`/pdf`, `/preview`, ...) keep calling the uncached function with their own projection.
 */
export const resolveShareLinkForPage = cache(
  (shareId: string): Promise<ResolvedShareLink | null> => resolveShareLink(shareId, { select: SHARE_PAGE_SELECT }),
);

/** Links of one document, default first then newest first. Archived links are excluded unless asked. */
export async function listShareLinks(input: { orgId: string | Types.ObjectId; docId: string | Types.ObjectId; includeArchived?: boolean }): Promise<ShareLink[]> {
  await connectMongo();
  const docId = oid(input.docId);
  const doc = (await DocModel.findOne({ _id: docId, orgId: oid(input.orgId), isDeleted: { $ne: true } }).select(DOC_SHARE_FIELDS).lean()) as DocLike | null;
  if (!doc) return [];
  await ensureDefaultLink(doc);
  const filter: Record<string, unknown> = { docId };
  if (!input.includeArchived) filter.archivedAt = null;
  const rows = await ShareLinkModel.find(filter).lean<ShareLink[]>();
  return rows.sort((a, b) => (a.isDefault === b.isDefault ? (b.createdDate?.getTime() ?? 0) - (a.createdDate?.getTime() ?? 0) : a.isDefault ? -1 : 1));
}

/**
 * The page-based counterpart of `listShareLinks`, for the one caller that must never hand back
 * "every link" as a matter of course: the links table a person actually scrolls through.
 *
 * `SHARE_LINKS_PER_DOC_MAX` (50) is a runaway guard, not a UI promise — nothing stops it moving to
 * the hundreds or thousands the product intends to support, and a table or a card that renders
 * "every link" today is a table that renders a thousand rows the day it does. This does the
 * sort/skip/limit in Mongo, so the row count reaching Node is `limit`, never the document's total
 * link count — unlike `listShareLinks`, which every other (server-internal, not user-facing) caller
 * keeps using because it needs the whole set to find one row in it.
 */
export async function listShareLinksPage(input: {
  orgId: string | Types.ObjectId;
  docId: string | Types.ObjectId;
  includeArchived?: boolean;
  page?: number;
  limit?: number;
  /**
   * Full-text search over this document's links (`label`/`audience`, via the `sharelinks` text
   * index) instead of listing all of them — mt_9ceLy7DqEr. When given, results are ranked by
   * relevance rather than default-first/newest-first, and `page` is ignored: a filtered lookup
   * inside one document is "find the match," not something worth paging through.
   */
  query?: string;
}): Promise<{ total: number; page: number; limit: number; links: ShareLink[] }> {
  await connectMongo();
  const docId = oid(input.docId);
  const page = Number.isFinite(input.page) && (input.page ?? 0) >= 1 ? Math.floor(input.page!) : 1;
  const limit = Number.isFinite(input.limit) && (input.limit ?? 0) >= 1 ? Math.min(100, Math.floor(input.limit!)) : 25;
  const doc = (await DocModel.findOne({ _id: docId, orgId: oid(input.orgId), isDeleted: { $ne: true } }).select(DOC_SHARE_FIELDS).lean()) as DocLike | null;
  if (!doc) return { total: 0, page, limit, links: [] };
  await ensureDefaultLink(doc);
  const query = (input.query ?? "").trim();
  const filter: Record<string, unknown> = { docId };
  if (!input.includeArchived) filter.archivedAt = null;

  if (query) {
    Object.assign(filter, { $text: { $search: query } });
    // `score` isn't a schema field — Mongoose's projection typing doesn't have a slot for a
    // `$meta` projection, hence the cast on find()'s second argument; `.sort()` already accepts
    // `{ $meta }` natively and needs none.
    const rows = await ShareLinkModel.find(filter, { score: { $meta: "textScore" } } as unknown as ProjectionType<ShareLink>)
      .sort({ score: { $meta: "textScore" } })
      .limit(limit)
      .lean<ShareLink[]>();
    return { total: rows.length, page: 1, limit, links: rows };
  }

  const [total, rows] = await Promise.all([
    ShareLinkModel.countDocuments(filter),
    // Default first, then newest — the same order `listShareLinks` sorts to in JS, done here in
    // Mongo so `skip`/`limit` land on the right rows instead of an arbitrary find() order.
    ShareLinkModel.find(filter)
      .sort({ isDefault: -1, createdDate: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean<ShareLink[]>(),
  ]);
  return { total, page, limit, links: rows };
}

/** One workspace-wide search hit: enough to identify the link and what it belongs to. */
export type ShareLinkSearchHit = {
  /** `"doc"` → `docId`/`docTitle` are set; `"project"` → `projectId`/`projectName` are. */
  kind: ShareLinkKind;
  docId: string | null;
  docTitle: string | null;
  docShareId: string | null;
  projectId: string | null;
  projectName: string | null;
  linkId: string;
  shareId: string;
  label: string;
  audience: string | null;
  isDefault: boolean;
  enabled: boolean;
  expiresAt: string | null;
  /** Same derivation as the link list, so a found link says whether it still opens. */
  status: "active" | "disabled" | "expired";
};

/**
 * Full-text search for a share link across the whole workspace, by `label`/`audience`
 * (mt_9ceLy7DqEr) — "find the a16z link" without already knowing which document it is on, which
 * `listShareLinksPage` above cannot answer (it needs a `docId` to start from).
 *
 * The text `$match` runs first (Mongo requires this, and it is also the selective step — the
 * `sharelinks` text index does the work), then joins to `docs` and drops any hit whose document
 * is deleted or archived, matching what `GET /api/docs` already excludes from search. That order —
 * filter by the doc, then rank, then limit — costs a touch more than limiting first, but it means
 * `limit` results really are the top `limit` *visible* matches, not `limit` candidates that might
 * mostly get thrown away afterward.
 *
 * Both kinds of link are searchable here — a project link's label ("Series A · Sequoia") is exactly
 * the kind of thing someone asks for by name. Each join is `preserveNullAndEmptyArrays`: the
 * document join produces nothing for a project link and vice versa, and an unguarded `$unwind`
 * would drop every project link from workspace search (a collection carries one text index, so
 * both kinds share this one). The `$match` after them keeps a hit only when *its own* owner is
 * live, which also drops a row whose owner was hard-deleted out from under it.
 */
export async function searchShareLinks(input: {
  orgId: string | Types.ObjectId;
  query: string;
  limit?: number;
}): Promise<ShareLinkSearchHit[]> {
  await connectMongo();
  const orgId = oid(input.orgId);
  const limit = Number.isFinite(input.limit) && (input.limit ?? 0) >= 1 ? Math.min(50, Math.floor(input.limit!)) : 20;
  const query = input.query.trim();
  if (!query) return [];

  const rows = (await ShareLinkModel.aggregate([
    { $match: { orgId, archivedAt: null, $text: { $search: query } } },
    { $lookup: { from: "docs", localField: "docId", foreignField: "_id", as: "doc" } },
    { $unwind: { path: "$doc", preserveNullAndEmptyArrays: true } },
    { $lookup: { from: "projects", localField: "projectId", foreignField: "_id", as: "project" } },
    { $unwind: { path: "$project", preserveNullAndEmptyArrays: true } },
    {
      $match: {
        $or: [
          { "doc.isDeleted": { $ne: true }, "doc.isArchived": { $ne: true }, "doc._id": { $ne: null } },
          { "project.isDeleted": { $ne: true }, "project._id": { $ne: null } },
        ],
      },
    },
    { $sort: { score: { $meta: "textScore" } } },
    { $limit: limit },
    {
      $project: {
        _id: 0,
        linkId: "$_id",
        shareId: 1,
        label: 1,
        audience: 1,
        isDefault: 1,
        enabled: 1,
        expiresAt: 1,
        docId: "$doc._id",
        docTitle: "$doc.title",
        docShareId: "$doc.shareId",
        projectId: "$project._id",
        projectName: "$project.name",
      },
    },
  ])) as Array<{
    linkId: Types.ObjectId;
    shareId: string;
    label: string;
    audience?: string | null;
    isDefault?: boolean;
    enabled?: boolean;
    expiresAt?: Date | null;
    docId?: Types.ObjectId | null;
    docTitle?: string | null;
    docShareId?: string | null;
    projectId?: Types.ObjectId | null;
    projectName?: string | null;
  }>;

  return rows.map((r) => ({
    kind: (r.projectId ? "project" : "doc") as ShareLinkKind,
    docId: r.docId ? String(r.docId) : null,
    docTitle: typeof r.docTitle === "string" ? r.docTitle : null,
    docShareId: typeof r.docShareId === "string" ? r.docShareId : null,
    projectId: r.projectId ? String(r.projectId) : null,
    projectName: typeof r.projectName === "string" ? r.projectName : null,
    linkId: String(r.linkId),
    shareId: r.shareId,
    label: r.label,
    audience: r.audience ?? null,
    isDefault: Boolean(r.isDefault),
    enabled: Boolean(r.enabled),
    expiresAt: r.expiresAt ? new Date(r.expiresAt).toISOString() : null,
    status: !r.enabled ? "disabled" : isExpired({ expiresAt: r.expiresAt ?? null }) ? "expired" : "active",
  }));
}

export type ShareLinkSettingsInput = {
  label?: string;
  audience?: string | null;
  enabled?: boolean;
  allowDownload?: boolean;
  allowRevisionHistory?: boolean;
  /** ISO date, null to clear. */
  expiresAt?: string | null;
  /** Plain password to set, null to clear, undefined to leave. */
  password?: string | null;
};

export class ShareLinkError extends Error {
  status: number;
  code: "validation" | "not_found" | "too_many_links";
  constructor(code: "validation" | "not_found" | "too_many_links", message: string) {
    super(message);
    this.name = "ShareLinkError";
    this.code = code;
    this.status = code === "not_found" ? 404 : code === "too_many_links" ? 409 : 400;
  }
}

/** A required, trimmed label of at most {@link SHARE_LINK_LABEL_MAX} characters. Shared with project links. */
export function validateLabel(label: unknown): string {
  const s = typeof label === "string" ? label.trim() : "";
  if (!s) throw new ShareLinkError("validation", "A label is required.");
  if (s.length > SHARE_LINK_LABEL_MAX) throw new ShareLinkError("validation", `Label must be ${SHARE_LINK_LABEL_MAX} characters or fewer.`);
  return s;
}

/** An optional, trimmed audience note; empty reads as null. Shared with project links. */
export function validateAudience(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  if (s.length > SHARE_LINK_AUDIENCE_MAX) throw new ShareLinkError("validation", `Audience must be ${SHARE_LINK_AUDIENCE_MAX} characters or fewer.`);
  return s;
}

/** A real, future ISO date, or null. Shared with project links so both kinds reject the same dates. */
export function validateExpiry(v: unknown): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const raw = String(v).trim();
  // `new Date` rolls impossible days forward ("2030-02-30" became March 2) and accepts expanded
  // years ("+275760-09-13"), so the link would expire on a date nobody gave. Require a 4-digit
  // year and a day that exists in that month.
  const ymd = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(raw);
  const d = new Date(raw);
  if (!ymd || Number.isNaN(d.getTime())) throw new ShareLinkError("validation", "expiresAt must be an ISO date.");
  const [year, month, day] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) {
    throw new ShareLinkError("validation", `expiresAt is not a real date: ${raw.slice(0, 10)}.`);
  }
  if (d.getTime() <= Date.now()) throw new ShareLinkError("validation", "expiresAt must be in the future.");
  return d;
}

/**
 * The five stored password fields for a settings update: `undefined` leaves them alone, `null`/`""`
 * clears them, a string sets a fresh scrypt hash plus the AES copy the owner can reveal. Shared
 * with project links, so a project link's password is the same material a document link's is.
 */
export function passwordFields(password: string | null | undefined): Record<string, unknown> {
  if (password === undefined) return {};
  if (password === null || password === "") {
    return { passwordSalt: null, passwordHash: null, passwordEnc: null, passwordEncIv: null, passwordEncTag: null };
  }
  const trimmed = password.trim();
  // Whitespace-only is a typo, not a request to clear: pass "" or null for that.
  if (trimmed.length < SHARE_PASSWORD_MIN) throw new ShareLinkError("validation", "Password cannot be blank.");
  if (trimmed.length > SHARE_PASSWORD_MAX) throw new ShareLinkError("validation", "Password is too long.");
  const { salt, hash } = hashSharePassword(trimmed);
  const enc = encryptSharePassword(trimmed);
  return { passwordSalt: salt, passwordHash: hash, passwordEnc: enc.enc, passwordEncIv: enc.iv, passwordEncTag: enc.tag };
}

/**
 * Keep the legacy Doc fields coherent: `shareEnabled` = any active link; the default link's
 * settings mirrored so readers that still look at the document (and a rollback build) agree.
 */
/**
 * Is this document shared *right now* — does it own any link that is on, unarchived and unexpired?
 *
 * This is the question the Free cap actually asks. `getWorkspaceUsage` counts documents whose
 * `shareEnabled` is not false, and `syncDocShareState` sets `shareEnabled = anyActive`, so a
 * document whose links are all switched off does not count. That is what made the cap bypassable:
 * turn a document's only link off (count drops), upload another document (the cap lets you), turn
 * the first link back on — and nothing re-checked. Repeat for as many documents as you like.
 *
 * So the rule is not "links are capped" — links are deliberately unlimited, one per audience. The
 * rule is that the *transition* of a document from unshared to shared is the thing the cap governs,
 * exactly as it governs sharing a document from the document-level switch.
 */
async function isDocCurrentlyShared(docId: Types.ObjectId): Promise<boolean> {
  const links = await ShareLinkModel.find({ docId, archivedAt: null }).lean<ShareLink[]>();
  return links.some((l) => isLinkActive(l));
}

export async function syncDocShareState(docId: string | Types.ObjectId): Promise<void> {
  await connectMongo();
  const id = oid(docId);
  const links = await ShareLinkModel.find({ docId: id, archivedAt: null }).lean<ShareLink[]>();
  const anyActive = links.some((l) => isLinkActive(l));
  const def = links.find((l) => l.isDefault) ?? null;
  const set: Record<string, unknown> = { shareEnabled: anyActive };
  if (def) {
    set.shareId = def.shareId;
    set.shareAllowPdfDownload = Boolean(def.allowDownload);
    set.shareAllowRevisionHistory = Boolean(def.allowRevisionHistory);
    set.sharePasswordSalt = def.passwordSalt ?? null;
    set.sharePasswordHash = def.passwordHash ?? null;
    set.sharePasswordEnc = def.passwordEnc ?? null;
    set.sharePasswordEncIv = def.passwordEncIv ?? null;
    set.sharePasswordEncTag = def.passwordEncTag ?? null;
  }
  await DocModel.updateOne({ _id: id }, { $set: set });
}

/** `link` is null when a plan limit refused the create; `limit.ok` is then false. */
export type CreateShareLinkResult = { link: ShareLink | null; limit: LimitCheck };

/**
 * Create a link. Enabled links count against the Free cap: when the cap is hit the link is
 * still created but disabled, and `limit.ok === false` tells the caller to surface the upsell
 * (same behaviour as creating a document at the cap).
 */
export async function createShareLink(input: {
  orgId: string | Types.ObjectId;
  docId: string | Types.ObjectId;
  userId: string | Types.ObjectId | null;
  createdVia: "web" | "api" | "mcp";
  settings: ShareLinkSettingsInput & { label: string };
}): Promise<CreateShareLinkResult> {
  await connectMongo();
  const orgId = oid(input.orgId);
  const docId = oid(input.docId);
  const doc = (await DocModel.findOne({ _id: docId, orgId, isDeleted: { $ne: true } }).select(DOC_SHARE_FIELDS).lean()) as DocLike | null;
  if (!doc) throw new ShareLinkError("not_found", "Document not found.");
  await ensureDefaultLink(doc);
  const count = await ShareLinkModel.countDocuments({ docId, archivedAt: null });
  if (count >= SHARE_LINKS_PER_DOC_MAX) throw new ShareLinkError("too_many_links", `A document can have at most ${SHARE_LINKS_PER_DOC_MAX} links.`);

  const label = validateLabel(input.settings.label);
  const audience = validateAudience(input.settings.audience);
  const expiresAt = validateExpiry(input.settings.expiresAt);
  // Letting recipients browse versions is a Pro feature. The document-level PATCH has always
  // refused it on Free; the per-link path has to refuse it too, or the gate is bypassable by
  // creating a link with the setting on.
  const historyLimit = input.settings.allowRevisionHistory ? await checkLimit(orgId, "version_history") : null;
  if (historyLimit && !historyLimit.ok) return { link: null, limit: historyLimit };

  // No plan check on the link itself. The Free cap counts shared **documents**; a document may
  // carry as many links as its sender needs, which is the entire point of the feature — one per
  // investor, per counterparty, per audience. Gating link creation on the document cap meant a
  // workspace sitting at three documents could not add a second link to any of them: the feature
  // switched off at exactly the moment someone starts to use it. `SHARE_LINKS_PER_DOC_MAX` is the
  // only ceiling, and it is a runaway guard rather than a plan limit.
  //
  // What *is* capped is putting one more document into the shared state. A new enabled link on a
  // document that is not currently shared does exactly that, so it answers to the documents cap —
  // the same answer `PATCH /api/docs/:id { shareEnabled: true }` gives. The link is still created,
  // switched off, and `limit.ok === false` tells the route to surface the upsell.
  let enabled = input.settings.enabled !== false;
  let limit: LimitCheck = { ok: true, warning: null };
  if (enabled && !(await isDocCurrentlyShared(docId))) {
    const documentsLimit = await checkLimit(orgId, "documents");
    if (!documentsLimit.ok) {
      enabled = false;
      limit = documentsLimit;
    } else if (documentsLimit.warning) {
      limit = documentsLimit;
    }
  }

  let created: ShareLink | null = null;
  for (let i = 0; i < 5 && !created; i++) {
    try {
      const row = await ShareLinkModel.create({
        orgId,
        docId,
        shareId: newShareId(),
        label,
        audience,
        isDefault: false,
        enabled,
        allowDownload: Boolean(input.settings.allowDownload),
        allowRevisionHistory: Boolean(input.settings.allowRevisionHistory),
        expiresAt,
        ...passwordFields(input.settings.password),
        createdByUserId: input.userId ? oid(input.userId) : null,
        createdVia: input.createdVia,
      });
      created = row.toObject() as ShareLink;
    } catch (e) {
      if (i === 4 || !/duplicate key/i.test(e instanceof Error ? e.message : String(e))) throw e;
    }
  }
  await syncDocShareState(docId);
  return { link: created as ShareLink, limit };
}

export type UpdateShareLinkResult = {
  link: ShareLink;
  limit: LimitCheck | null;
  /**
   * Links this call brought back: siblings the document switch had disabled, restored because
   * enabling one link re-shares the document. Present only when there were any.
   */
  restored?: ShareLink[];
};

/** Patch a link's settings. Enabling a disabled link re-checks the Free cap. */
export async function updateShareLink(input: {
  orgId: string | Types.ObjectId;
  linkId: string | Types.ObjectId;
  settings: ShareLinkSettingsInput;
  /**
   * Internal: set by the document-level switch so it can tell its own disables from the sender's —
   * and so the documents-cap check below knows the caller already ran it. `PATCH /api/docs/:id
   * { shareEnabled: true }` asks the cap before it calls in; asking again here would refuse the
   * switch the approval it was just given.
   */
  viaDocSwitch?: boolean;
}): Promise<UpdateShareLinkResult> {
  await connectMongo();
  // `DOC_LINK_FILTER`: a link id addressed through a document route must be a document link, or a
  // caller holding a project link's id could patch it here — where `syncDocShareState(link.docId)`
  // below would then run with no document. Project links are patched by `updateProjectLink()`.
  const link = await ShareLinkModel.findOne({ _id: oid(input.linkId), orgId: oid(input.orgId), archivedAt: null, ...DOC_LINK_FILTER }).lean<ShareLink>();
  if (!link) throw new ShareLinkError("not_found", "Link not found.");
  const set: Record<string, unknown> = {};
  const s = input.settings;
  if (s.label !== undefined) set.label = validateLabel(s.label);
  if (s.audience !== undefined) set.audience = validateAudience(s.audience);
  if (s.allowDownload !== undefined) set.allowDownload = Boolean(s.allowDownload);
  if (s.allowRevisionHistory !== undefined) {
    // Same Pro gate as the document-level PATCH; turning it off is always allowed.
    if (s.allowRevisionHistory && !link.allowRevisionHistory) {
      const historyLimit = await checkLimit(link.orgId, "version_history");
      if (!historyLimit.ok) return { link, limit: historyLimit };
    }
    set.allowRevisionHistory = Boolean(s.allowRevisionHistory);
  }
  if (s.expiresAt !== undefined) set.expiresAt = validateExpiry(s.expiresAt);
  Object.assign(set, passwordFields(s.password));
  let limit: LimitCheck | null = null;
  if (s.enabled !== undefined) {
    /**
     * Turning a link *on* is a plan decision when nothing else is keeping its document shared.
     *
     * The comment here used to say the cap counts the document "whether this link is switched on or
     * off", which is not what `getWorkspaceUsage` measures: it counts `shareEnabled`, and
     * `syncDocShareState` derives that from whether any link is active. So off really did mean
     * uncounted, and the disable → upload → re-enable cycle walked a Free workspace past the cap
     * indefinitely. Turning a link off is never gated; only the transition back into shared is.
     */
    if (
      s.enabled === true &&
      input.viaDocSwitch !== true &&
      !isLinkActive(link) &&
      !(await isDocCurrentlyShared(link.docId as Types.ObjectId))
    ) {
      const documentsLimit = await checkLimit(link.orgId, "documents");
      if (!documentsLimit.ok) return { link, limit: documentsLimit };
      if (documentsLimit.warning) limit = documentsLimit;
    }
    set.enabled = Boolean(s.enabled);
    set.disabledByDocSwitch = !s.enabled && input.viaDocSwitch === true;
  }
  if (Object.keys(set).length === 0) return { link, limit };
  const updated = await ShareLinkModel.findOneAndUpdate({ _id: link._id }, { $set: set }, { new: true }).lean<ShareLink>();

  /**
   * Enabling one link re-shares the document, so it has to restore what the document switch took
   * down. The mirror of the same rule in `updateProjectLink`, and it was missing here.
   *
   * `Doc.shareEnabled` is derived from "at least one active link" (`syncDocShareState`), so turning
   * any single link on makes the document shared again. There were then two routes to a shared
   * document and only one put the other links back: the explicit switch calls
   * `setAllLinksEnabled`, which restores every link marked `disabledByDocSwitch`, while enabling
   * one link restored nothing. The document came back with most of its recipients still locked out,
   * silently, and nothing would ever clear their marker.
   *
   * Only marked links are restored. A link the sender revoked on its own is not marked and stays
   * revoked — the distinction the marker exists for.
   */
  const restored: ShareLink[] = [];
  if (set.enabled === true && !input.viaDocSwitch) {
    const siblings = await ShareLinkModel.find({
      docId: link.docId,
      ...DOC_LINK_FILTER,
      archivedAt: null,
      _id: { $ne: link._id },
      enabled: false,
      disabledByDocSwitch: true,
    }).lean<ShareLink[]>();
    for (const sib of siblings) {
      const back = await ShareLinkModel.findOneAndUpdate(
        { _id: sib._id },
        { $set: { enabled: true, disabledByDocSwitch: false } },
        { new: true },
      ).lean<ShareLink>();
      if (back) restored.push(back);
    }
  }

  // `DOC_LINK_FILTER` on the lookup above guarantees a document link, so `docId` is set.
  await syncDocShareState(link.docId as Types.ObjectId);
  return { link: updated ?? link, limit, ...(restored.length ? { restored } : {}) };
}

/**
 * Promote a link to be the document's default: the one the side panel shows, the one
 * `share_pdf` and the legacy document-level routes write to, and the one `Doc.shareId` points at.
 *
 * The previous default stays a perfectly good link (same URL, same stats) and becomes deletable.
 * A link on another document, or an archived one, is refused.
 */
export async function setDefaultShareLink(input: {
  orgId: string | Types.ObjectId;
  docId: string | Types.ObjectId;
  linkId: string | Types.ObjectId;
}): Promise<ShareLink> {
  await connectMongo();
  const orgId = oid(input.orgId);
  const docId = oid(input.docId);
  const next = await ShareLinkModel.findOne({ _id: oid(input.linkId), orgId, docId, archivedAt: null, ...DOC_LINK_FILTER }).lean<ShareLink>();
  if (!next) throw new ShareLinkError("not_found", "Link not found.");
  if (next.isDefault) return next;
  // Scoped to this document, and explicitly to document links: an `{ isDefault: true }` filter that
  // ever loses its owner clause would clear the default on every link in the database, project
  // links included. `syncProjectShareState` in projectLinks.ts carries the mirror-image comment.
  await ShareLinkModel.updateMany({ docId, ...DOC_LINK_FILTER, isDefault: true }, { $set: { isDefault: false } });
  const updated = await ShareLinkModel.findOneAndUpdate({ _id: next._id }, { $set: { isDefault: true } }, { new: true }).lean<ShareLink>();
  // Moves `Doc.shareId` and mirrors the new default's settings onto the legacy document fields.
  await syncDocShareState(docId);
  return updated ?? next;
}

/** Soft-delete a link: it stops resolving; its analytics stay. The default link cannot be archived (disable it instead). */
export async function archiveShareLink(input: { orgId: string | Types.ObjectId; linkId: string | Types.ObjectId }): Promise<ShareLink> {
  await connectMongo();
  const link = await ShareLinkModel.findOne({ _id: oid(input.linkId), orgId: oid(input.orgId), archivedAt: null, ...DOC_LINK_FILTER }).lean<ShareLink>();
  if (!link) throw new ShareLinkError("not_found", "Link not found.");
  if (link.isDefault) throw new ShareLinkError("validation", "The default link cannot be deleted; disable it instead.");
  const updated = await ShareLinkModel.findOneAndUpdate({ _id: link._id }, { $set: { archivedAt: new Date(), enabled: false } }, { new: true }).lean<ShareLink>();
  // `DOC_LINK_FILTER` on the lookup above guarantees a document link, so `docId` is set.
  await syncDocShareState(link.docId as Types.ObjectId);
  return updated ?? link;
}

/**
 * A disabled link the document switch is allowed to turn back on.
 *
 * Only the switch's own work: `disabledByDocSwitch` is written on every disable that goes through
 * `updateShareLink`, `true` when the document switch did it and `false` when the sender disabled
 * that one link — which, for a default link, is the only way the product lets them revoke a
 * recipient at all (`archiveShareLink` refuses to delete it). `ensureDefaultLink` marks a link it
 * has to create already-off for the same reason: the document is off, so the switch owns it.
 *
 * The rows with **no marker** are the ones written before the field existed, and they keep the old
 * behaviour *exactly*: restored only when every link on the document is off. That condition is the
 * whole of the old rule and it matters. Treating an unmarked row as restorable on its own widened
 * the switch in precisely the mixed case the fix was written for — a pre-marker document with link
 * A live and link B revoked would hand B back, which is the same silent un-revoking, one branch
 * over. Unknown provenance is a reason to be conservative, not permissive.
 *
 * This used to be decided per *document* instead of per link — "no marked links and none enabled"
 * meant legacy — and that shape cannot tell a pre-marker document from one whose every link the
 * owner deliberately revoked. It read the second as the first, so turning sharing back on handed a
 * revoked recipient their original URL again, silently, with no warning in the response or the UI.
 */
export function switchMayRestore(link: ShareLink, opts: { everyLinkDisabled: boolean }): boolean {
  // Absent, not false: `.lean()` returns the stored row, so a field never written stays undefined.
  const marker = (link as { disabledByDocSwitch?: boolean | null }).disabledByDocSwitch;
  if (marker === true) return true; // the switch turned it off, so the switch may turn it back on
  if (marker === false) return false; // the sender revoked this one recipient; that stands
  return opts.everyLinkDisabled; // pre-marker: only the old all-off fallback
}

/**
 * Enable or disable every link of a document at once (the document-level share switch).
 *
 * Turning the switch off marks each link it disables (`disabledByDocSwitch`). Turning it back on
 * re-enables only those, so a link the sender revoked on its own stays revoked — see
 * {@link switchMayRestore} for the one exception, links written before the marker existed.
 */
export async function setAllLinksEnabled(input: { orgId: string | Types.ObjectId; docId: string | Types.ObjectId; enabled: boolean }): Promise<{ changed: number; limit: LimitCheck | null }> {
  const links = await listShareLinks({ orgId: input.orgId, docId: input.docId });
  const everyLinkDisabled = links.every((l) => !l.enabled);
  let changed = 0;
  let limit: LimitCheck | null = null;
  for (const l of links) {
    if (Boolean(l.enabled) === input.enabled) continue;
    if (input.enabled && !switchMayRestore(l, { everyLinkDisabled })) continue;
    const res = await updateShareLink({ orgId: input.orgId, linkId: l._id, settings: { enabled: input.enabled }, viaDocSwitch: true });
    if (res.limit && !res.limit.ok) {
      limit = res.limit;
      break;
    }
    changed += 1;
  }
  return { changed, limit };
}

/**
 * Record activity on the link row (best effort; the analytics rows stay the source of truth).
 *
 * `lastViewedAt` is a timestamp, not a side effect of a counter: it moves on every view and on
 * every download. It used to be written only when a brand-new viewer appeared, so a recipient who
 * came back every day never moved it and a download-only link read "Never viewed" — beside a
 * non-zero Views column, which readers took as proof the numbers were junk.
 *
 * `viewCount` counts *viewers* (one per new `ShareView` row), so `opts.countView: false` lets a
 * returning viewer move the timestamp without inflating it. `$max` sets a null/absent field.
 */
export async function touchShareLink(
  shareId: string,
  kind: "view" | "download",
  opts: { countView?: boolean } = {},
): Promise<void> {
  try {
    await connectMongo();
    const now = new Date();
    await ShareLinkModel.updateOne(
      { shareId },
      kind === "view"
        ? { $max: { lastViewedAt: now }, ...(opts.countView === false ? {} : { $inc: { viewCount: 1 } }) }
        : { $max: { lastViewedAt: now }, $inc: { downloadCount: 1 } },
    );
  } catch {
    // never fail a share page over a counter
  }
}
