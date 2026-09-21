/**
 * Typed client for the lnkdrp REST API, one instance per MCP session.
 *
 * Every call carries the caller's own `Authorization: Bearer lnk_…`, the `x-lnkdrp-agent`
 * attribution header (read lazily so it can change after `initialize`), JSON content types and a
 * 20s timeout. Non-2xx responses become `ToolError`s via `mapApiError`. The key is never logged.
 *
 * Envelopes verified against the route handlers on 2026-09-13:
 * - `GET  /api/agent/whoami`                   -> `{ ok, userId, email, orgId, orgName, isPersonalOrg, plan, keyPrefix, scopes, client }`
 * - `POST /api/docs` `{ title }`               -> 201 `{ doc: { id, shareId, title, status, shareEnabled, … }, planWarning? }`; 402 `{ code: "plan_limit", … }` at the Free shared-document cap
 * - `GET  /api/docs?q=&ids=&page=&limit=`     -> `{ total, page, limit, docs: [{ id, shareId, title, status, version, one_liner, … }] }` (`q` matches a title or any link slug; `ids` is a direct lookup)
 * - `GET  /api/activity?limit=&cursor=&type=&docId=&who=` -> `{ items: [{ id, type, createdDate, actor, agent, doc, project, meta }], nextCursor }` (`who=agents` = anything an MCP/API client did)
 * - `GET  /api/docs/:id?lite=1`                -> `{ doc: { id, shareId, title, status, shareEnabled, shareAllowPdfDownload,
 *                                                  shareAllowRevisionHistory, sharePasswordEnabled, previewImageUrl,
 *                                                  currentUploadId, aiOutput, isArchived, … } }`
 * - `PATCH /api/docs/:id`                      -> `{ doc: {…same…}, planWarning? }`; 402 `{ code: "plan_limit", … }`
 * - `DELETE /api/docs/:id`                     -> `{ ok: true }`
 * - `POST /api/docs/:id/share-password` `{ password }` (string sets, `null` removes) -> `{ sharePasswordEnabled }`
 * - `GET  /api/docs/:id/links/:linkId/password` -> `{ passwordEnabled, password }` (owner read-back; writes an activity row)
 * - `POST /api/docs/:id/links/:linkId/password/verify` `{ password }` -> `{ passwordEnabled, matches }` (no cookie, no view, own limiter)
 * - `POST /api/uploads`                        -> 201 `{ upload: { id, docId, version, status } }`
 * - `POST /api/uploads/:id/import-url` `{ url }` -> `{ ok: true }`; 400 `{ error }`; 415 `{ error, code }`
 * - `POST /api/uploads/:id/process`            -> `{ ok: true, alreadyProcessing? }`; 409 `UPLOAD_NOT_READY`; 402 credits
 * - `POST /api/uploads` also takes `{ summary?, keyPoints? }` (both or neither) -> agent summary, 0 credits; 400 `{ error, code: "invalid_summary" }`
 * - `GET  /api/uploads/:id`                    -> `{ upload: { id, docId, status, version, ai: UploadAi | null }, doc: { id, status } }`
 * - `GET  /api/credits/snapshot?fast=1`        -> `{ creditsRemaining, blocked, includedThisCycle, cycleEnd, … }` (session or key actor)
 * - `GET  /api/plan`                           -> `{ plan: "free"|"pro", limits, usage, … }`
 * - `GET  /api/docs/:id/shareviews?days&viewers=1&shareId=` -> `{ ok, days, analyticsDaysLimit, analyticsTier, viewerCount, totals, series (per day: views, opens, downloads), viewers, anonymousViewers }` (`shareId` scopes every number to one link)
 * - `GET  /api/docs/:id/links`                 -> `{ links: ShareLinkDTO[] }` (default link first)
 * - `POST /api/docs/:id/links` `{ label, … }`  -> 201 `{ link, planWarning? }` (always enabled — links are never plan-capped; `planWarning` only flags nearness to the shared-document cap)
 * - `PATCH /api/docs/:id/links/:linkId`        -> `{ link, planWarning? }`
 * - `DELETE /api/docs/:id/links/:linkId`       -> 204 (soft archive; analytics kept)
 *
 * Projects, verified against the route handlers on 2026-09-17:
 * - `GET  /api/projects?q=&page=&limit=`       -> `{ total, page, limit, projects: [{ id, shareId, name, slug, description, docCount, autoAddFiles, createdDate, updatedDate }] }`
 *                                                  (non-request projects only; `q` matches name/description, not slug; always pass `limit` — the route reads a missing one as 1)
 * - `POST /api/projects` `{ name, description? }` -> 201 `{ project: { id, shareId, name, slug, description, docCount, autoAddFiles }, planWarning? }`;
 *                                                  402 `{ code: "plan_limit", limit: "projects" }`; 409 duplicate name
 * - `GET  /api/projects/:id/docs?q=&page=&limit=` -> `{ project: { id, shareId, name, slug, description, autoAddFiles, shareEnabled, isRequest, request }, total, page, limit,
 *                                                  docs: [{ id, shareId, title, status, version, previewImageUrl, projectIds, createdDate, updatedDate }] }` (archived docs excluded; 404 unknown project)
 * - `PATCH /api/projects/:id` `{ name, description, autoAddFiles, shareEnabled? }` -> `{ project }`. Without `name` it is a
 *                                                  `shareEnabled`-only toggle; WITH `name` it overwrites description and autoAddFiles too
 *                                                  (omitted = "" / false), so callers must send the current values.
 * - `DELETE /api/projects/:id`                 -> `{ ok: true }` (hard delete; documents stay and lose the membership)
 * - `PATCH /api/docs/:id` `{ addProjectId }` / `{ removeProjectId }` -> `{ doc: { …, projectIds } }`. The route does not
 *                                                  check the project exists in the workspace, so the tools verify it first.
 *
 * Project share links, verified against the route handlers on 2026-09-17 (docs/prds/lnkdrp-project-links.md):
 * - `GET  /api/projects/:id/links?q=&page=&limit=&includeArchived=1` -> `{ total, page, limit, links: ProjectLinkDTO[] }` (default link first, then newest)
 * - `POST /api/projects/:id/links` `{ label, … }` -> 201 `{ link }`; **402 `{ code: "plan_limit", limit: "project_links" }` on Free**
 *                                                  (nothing written — no `planWarning` half-state, unlike the document link route); 409 past 50 links
 * - `PATCH /api/projects/:id/links/:linkId`    -> `{ link }`
 * - `DELETE /api/projects/:id/links/:linkId`   -> 204 (soft archive; 400 on the project's default link)
 *   Writes are owner/admin; reads are open to any member. A `ProjectLinkDTO` has no `docId` and no
 *   `allowRevisionHistory`, and its `shareId` resolves at `/p/:shareId`, not `/s/:shareId`.
 */
import { API_TIMEOUT_MS } from "./config";
import { mapApiError, ToolError } from "./errors";

export type Whoami = {
  ok: true;
  userId: string;
  email: string | null;
  orgId: string;
  orgName: string | null;
  isPersonalOrg: boolean;
  plan: string;
  keyPrefix: string;
  scopes: string[];
  client: string;
};

export type PlanWarning = { limit: string; used: number; max: number; grace: unknown };

export type DocStatus = "draft" | "preparing" | "ready" | "failed";

export type ApiDoc = {
  id: string;
  shareId: string | null;
  title: string | null;
  status: DocStatus | string;
  isArchived: boolean;
  currentUploadId: string | null;
  previewImageUrl: string | null;
  oneLiner: string | null;
  summary: string | null;
  shareEnabled: boolean;
  shareAllowPdfDownload: boolean;
  shareAllowRevisionHistory: boolean;
  sharePasswordEnabled: boolean;
  /** Projects the document belongs to (only ones that exist in this workspace). */
  projectIds: string[];
  /** Version number of the current upload (1 = first upload). */
  version: number | null;
  /** Pages in the current version; null when it was processed before page counts were recorded. */
  pageCount: number | null;
  /** The key points stored with the current summary (the caller's own, or the AI's). */
  keyPoints: string[];
};

export type ApiDocListItem = { id: string; shareId: string | null; title: string | null; status: string };

/** One row of `GET /api/docs`, with the fields an agent can act on. */
export type ApiDocsPageItem = ApiDocListItem & {
  version: number | null;
  oneLiner: string | null;
  previewImageUrl: string | null;
  createdDate: string | null;
  updatedDate: string | null;
};

export type ApiDocsPage = { total: number; page: number; limit: number; docs: ApiDocsPageItem[] };

/** One row of `GET /api/activity`. `meta` is the event's raw payload; its text fields are untrusted. */
export type ApiActivityItem = {
  id: string;
  type: string;
  createdDate: string;
  actor: { userId: string | null; name: string | null; email: string | null; kind: string };
  agent: { client: string; label: string | null; version: string | null } | null;
  doc: { id: string; title: string | null; shareId: string | null } | null;
  project: { id: string; name: string | null } | null;
  meta: Record<string, unknown>;
};

export type ApiActivityPage = { items: ApiActivityItem[]; nextCursor: string | null };

/** One share link of a document (`ShareLinkDTO` from `src/lib/share/links.ts`). */
export type ApiShareLink = {
  id: string;
  docId: string;
  shareId: string;
  label: string;
  audience: string | null;
  isDefault: boolean;
  enabled: boolean;
  allowDownload: boolean;
  allowRevisionHistory: boolean;
  passwordEnabled: boolean;
  expiresAt: string | null;
  active: boolean;
  status: "active" | "disabled" | "expired" | "archived" | string;
  createdVia: string;
  createdAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  downloadCount: number;
};

/** One `GET /api/share-links` search hit — a link plus enough of its document to tell it apart. */
export type ApiShareLinkSearchHit = {
  /** "doc" for a document's link, "project" for a project (data room) link. */
  kind: "doc" | "project";
  /** null on a project link: it belongs to a project, not a document. */
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
  status: string;
};

/** Settings accepted when creating or updating a share link. */
export type ShareLinkPatch = Partial<{
  label: string;
  audience: string | null;
  enabled: boolean;
  allowDownload: boolean;
  allowRevisionHistory: boolean;
  expiresAt: string | null;
  password: string | null;
}>;

/**
 * One share link of a *project* (`ProjectLinkDTO` from `src/lib/share/projectLinks.ts`).
 *
 * Deliberately not `ApiShareLink`: a project link has no `docId` and no `allowRevisionHistory` (it
 * has no single document whose versions a recipient could browse), and the server does not send
 * either field. Carrying them as permanent nulls would invite a caller to offer a
 * revision-history switch that can never be turned on.
 */
export type ApiProjectLink = {
  id: string;
  projectId: string;
  shareId: string;
  label: string;
  audience: string | null;
  isDefault: boolean;
  enabled: boolean;
  allowDownload: boolean;
  passwordEnabled: boolean;
  expiresAt: string | null;
  active: boolean;
  status: "active" | "disabled" | "expired" | "archived" | string;
  createdVia: string;
  createdAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  downloadCount: number;
};

/** Settings accepted when creating or updating a project link (no `allowRevisionHistory`). */
export type ProjectLinkPatch = Partial<{
  label: string;
  audience: string | null;
  enabled: boolean;
  allowDownload: boolean;
  expiresAt: string | null;
  password: string | null;
}>;

export type ApiUpload = { id: string; docId: string; version: number | null; status: string };

/** `upload.ai` from `GET /api/uploads/:id`: what the automatic AI steps did and why. */
export type UploadAi = {
  summary: "done" | "skipped" | "failed" | string;
  compare: "done" | "skipped" | "failed" | "not_applicable" | string;
  reason: string | null;
  code: "out_of_credits" | "daily_cap" | "plan" | "recipient" | "error" | string | null;
  creditsNeeded: number | null;
  creditsUsed: number;
  source: "owner" | "recipient" | string;
  summaryBy: { kind: string; client: string } | null;
};

/** The fields of `GET /api/credits/snapshot` the MCP server uses. `resetAt` is the first reset-like date found. */
export type CreditsSnapshotLite = {
  creditsRemaining: number | null;
  blocked: boolean;
  includedThisCycle: number | null;
  cycleEnd: string | null;
  resetAt: string | null;
  /**
   * True when the workspace can be billed for on-demand credits, which is Pro only (9556490). A Free
   * workspace never has on-demand: past its one-time starter credits it buys credit packs instead.
   */
  onDemandEnabled: boolean;
};

/** `GET /api/plan`'s caps and current usage. A `limit` of `null` means unlimited (Pro). */
export type PlanSnapshotLite = {
  plan: string | null;
  limits: { documents: number | null; projects: number | null; analyticsDays: number | null; collaborators: number | null };
  usage: { documents: number; projects: number; members: number };
};

export type DocPatch = Partial<{
  title: string;
  shareEnabled: boolean;
  shareAllowPdfDownload: boolean;
  shareAllowRevisionHistory: boolean;
  isArchived: boolean;
  /** Add the document to this project (membership only; the primary pointer is set if it had none). */
  addProjectId: string;
  /** Take the document out of this project. The document itself is untouched. */
  removeProjectId: string;
}>;

/** One project from `/api/projects…`. Fields a given route does not return are null. */
/** One tag, as the tag routes return it. `count` is present only on the workspace listing. */
export type ApiTag = { id: string; name: string; slug: string; color: string; count: number | null };

/** One starred document, as `GET /api/starred` lists it. */
export type ApiStarredDoc = { id: string; title: string | null; starredAt: string | null };

export type ApiProject = {
  id: string;
  shareId: string | null;
  name: string;
  slug: string;
  description: string;
  docCount: number | null;
  autoAddFiles: boolean;
  /** Whether the public `/p/:shareId` page resolves. Null where the route does not say (the list). */
  shareEnabled: boolean | null;
  /** Request repos share the collection; the project tools refuse them. */
  isRequest: boolean;
  createdDate: string | null;
  updatedDate: string | null;
};

export type ApiProjectsPage = { total: number; page: number; limit: number; projects: ApiProject[] };

/** One document row of `GET /api/projects/:id/docs`. */
export type ApiProjectDoc = {
  id: string;
  shareId: string | null;
  title: string | null;
  status: string;
  version: number | null;
  previewImageUrl: string | null;
  createdDate: string | null;
  updatedDate: string | null;
};

export type ApiProjectDocsPage = { project: ApiProject; total: number; page: number; limit: number; docs: ApiProjectDoc[] };

export type ShareViewsTotals = {
  views: number;
  /**
   * Owner-side opens that were recorded and excluded from every other figure. `views: 0,
   * ownerPreviews: 3` is "only the owner has opened this", not "nobody has". A floor: the flag
   * needs a signed-in session, so a logged-out owner counts as a recipient.
   */
  ownerPreviews: number;
  /** Tab sessions in the window. Counts events, where `views` counts recipients. */
  opens: number;
  /** `opens` is missing rows for traffic older than per-session tracking: a floor, not a count. */
  opensPartial: boolean;
  downloads: number;
  pagesViewed: number;
  timeSpentMs: number;
  authenticatedViewers: number;
  anonymousViewers: number;
};

export type ShareViewsViewer = {
  name: string | null;
  email: string | null;
  views: number;
  timeSpentMs: number;
  pagesViewed: number;
  pagesSeen: number[];
  /** Milliseconds on each page, keyed by page number ("1", "2", …). Deep tier only. */
  pageTimeMsByPage: Record<string, number>;
  firstSeen: string | null;
  lastSeen: string | null;
};

/**
 * Traffic that reached this document through a link belonging to a *project*, not to the document.
 *
 * Kept apart from `totals` rather than folded into it, matching the upstream route: a project
 * link's rows have no `docId` of their own, and counting them in the document's totals once made
 * them render as a "Deleted link". But they are real reads by real people — often the only named
 * ones — so they are reported here instead of being dropped.
 */
export type ProjectLinkTraffic = {
  views: number;
  viewers: number;
  links: Array<{
    shareId: string;
    label: string | null;
    projectId: string | null;
    projectName: string | null;
    views: number;
    viewers: number;
    lastViewedAt: string | null;
  }>;
  /** Per-reader rows; names and emails only on the deep tier and only when viewers were asked for. */
  viewerRows: Array<{
    shareId: string;
    projectId: string | null;
    projectName: string | null;
    views: number;
    pagesViewed: number;
    timeSpentMs: number;
    lastViewedAt: string | null;
    viewerName: string | null;
    viewerEmail: string | null;
  }>;
};

export type ShareViews = {
  days: number;
  /**
   * Lifetime figures for the same scope, beside the windowed ones.
   *
   * Without these the default 15-day window is the whole answer, so a deck shared three months ago
   * and read then reports `views: 0` — and "has anyone read this?" answers "nobody" about a
   * document with a hundred readings. The window is a lens, not the truth.
   */
  totalsAllTime: {
    views: number;
    ownerPreviews: number;
    opens: number;
    opensPartial: boolean;
    downloads: number;
    pagesViewed: number;
  } | null;
  /** Most recent recorded activity in this scope, ever. Null when nothing has been recorded. */
  lastViewedAt: string | null;
  analyticsDaysLimit: number | null;
  analyticsTier: "basic" | "deep" | string;
  viewerCount: number;
  totals: ShareViewsTotals;
  series: Array<{ date: string; views: number; opens: number; downloads: number }>;
  viewers: ShareViewsViewer[];
  anonymousViewers: ShareViewsViewer[];
  /** Present only when project links carried traffic to this document in the window. */
  projectLinkTraffic: ProjectLinkTraffic | null;
};

type Query = Record<string, string | number | boolean | undefined>;

/** Narrow to a plain object, else `{}`. */
function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A string value or null. */
function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** A finite number or `fallback`. */
function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Normalise a doc from `GET/POST/PATCH /api/docs…` (`{ doc }` envelope already unwrapped). */
function asDoc(raw: unknown): ApiDoc {
  const d = rec(raw);
  const ai = rec(d.aiOutput);
  const id = strOrNull(d.id) ?? strOrNull(d._id);
  if (!id) throw new ToolError("upstream", "lnkdrp API returned a document without an id.");
  return {
    id,
    shareId: strOrNull(d.shareId),
    title: strOrNull(d.title),
    status: strOrNull(d.status) ?? "draft",
    isArchived: Boolean(d.isArchived),
    currentUploadId: strOrNull(d.currentUploadId),
    previewImageUrl: strOrNull(d.previewImageUrl),
    oneLiner: strOrNull(ai.one_liner),
    summary: strOrNull(ai.summary),
    shareEnabled: d.shareEnabled !== false,
    shareAllowPdfDownload: Boolean(d.shareAllowPdfDownload),
    shareAllowRevisionHistory: Boolean(d.shareAllowRevisionHistory),
    sharePasswordEnabled: Boolean(d.sharePasswordEnabled ?? d.sharePasswordHash),
    projectIds: Array.isArray(d.projectIds) ? d.projectIds.filter((x): x is string => typeof x === "string") : [],
    version: typeof d.currentUploadVersion === "number" ? d.currentUploadVersion : null,
    pageCount: typeof d.currentUploadPages === "number" ? d.currentUploadPages : null,
    keyPoints: Array.isArray(ai.primary_capabilities_or_scope)
      ? ai.primary_capabilities_or_scope.filter((x): x is string => typeof x === "string")
      : [],
  };
}

/** Normalise a project from any `/api/projects…` envelope (already unwrapped). */
function asTag(raw: unknown): ApiTag {
  const t = rec(raw);
  return {
    id: strOrNull(t.id) ?? "",
    name: strOrNull(t.name) ?? "",
    slug: strOrNull(t.slug) ?? "",
    color: strOrNull(t.color) ?? "slate",
    count: typeof t.count === "number" && Number.isFinite(t.count) ? t.count : null,
  };
}

function asProject(raw: unknown): ApiProject {
  const p = rec(raw);
  const id = strOrNull(p.id);
  if (!id) throw new ToolError("upstream", "lnkdrp API returned a project without an id.");
  return {
    id,
    shareId: strOrNull(p.shareId),
    name: strOrNull(p.name) ?? "",
    slug: strOrNull(p.slug) ?? "",
    description: strOrNull(p.description) ?? "",
    docCount: typeof p.docCount === "number" && Number.isFinite(p.docCount) ? p.docCount : null,
    autoAddFiles: Boolean(p.autoAddFiles),
    shareEnabled: typeof p.shareEnabled === "boolean" ? p.shareEnabled : null,
    // `request` is non-null only for request repos (the docs route sets it from the token too).
    isRequest: Boolean(p.isRequest) || (p.request !== undefined && p.request !== null),
    createdDate: strOrNull(p.createdDate),
    updatedDate: strOrNull(p.updatedDate),
  };
}

/** Normalise `upload.ai`; null while processing has not finished. */
function asUploadAi(raw: unknown): UploadAi | null {
  if (!raw || typeof raw !== "object") return null;
  const a = rec(raw);
  const by = rec(a.summaryBy);
  return {
    summary: strOrNull(a.summary) ?? "done",
    compare: strOrNull(a.compare) ?? "not_applicable",
    reason: strOrNull(a.reason),
    code: strOrNull(a.code),
    creditsNeeded: typeof a.creditsNeeded === "number" ? a.creditsNeeded : null,
    creditsUsed: num(a.creditsUsed),
    source: strOrNull(a.source) ?? "owner",
    summaryBy: typeof by.client === "string" ? { kind: strOrNull(by.kind) ?? "agent", client: by.client } : null,
  };
}

/** Normalise the optional `planWarning` returned by doc create/patch. */
function asPlanWarning(raw: unknown): PlanWarning | undefined {
  const w = rec(raw);
  if (typeof w.limit !== "string") return undefined;
  return { limit: w.limit, used: num(w.used), max: num(w.max), grace: w.grace ?? null };
}

/** Normalise one share link from `/api/docs/:id/links` (`{ link }` / `{ links }` already unwrapped). */
function asShareLink(raw: unknown): ApiShareLink {
  const l = rec(raw);
  const id = strOrNull(l.id);
  const shareId = strOrNull(l.shareId);
  if (!id || !shareId) throw new ToolError("upstream", "lnkdrp API returned a share link without an id.");
  return {
    id,
    docId: strOrNull(l.docId) ?? "",
    shareId,
    label: strOrNull(l.label) ?? "",
    audience: strOrNull(l.audience),
    isDefault: Boolean(l.isDefault),
    enabled: Boolean(l.enabled),
    allowDownload: Boolean(l.allowDownload),
    allowRevisionHistory: Boolean(l.allowRevisionHistory),
    passwordEnabled: Boolean(l.passwordEnabled),
    expiresAt: strOrNull(l.expiresAt),
    active: Boolean(l.active),
    status: strOrNull(l.status) ?? "active",
    createdVia: strOrNull(l.createdVia) ?? "api",
    createdAt: strOrNull(l.createdAt),
    lastViewedAt: strOrNull(l.lastViewedAt),
    viewCount: num(l.viewCount),
    downloadCount: num(l.downloadCount),
  };
}

/** Normalise one project link from `/api/projects/:id/links` (`{ link }` / `{ links }` unwrapped). */
function asProjectLink(raw: unknown): ApiProjectLink {
  const l = rec(raw);
  const id = strOrNull(l.id);
  const shareId = strOrNull(l.shareId);
  if (!id || !shareId) throw new ToolError("upstream", "lnkdrp API returned a project link without an id.");
  return {
    id,
    projectId: strOrNull(l.projectId) ?? "",
    shareId,
    label: strOrNull(l.label) ?? "",
    audience: strOrNull(l.audience),
    isDefault: Boolean(l.isDefault),
    enabled: Boolean(l.enabled),
    allowDownload: Boolean(l.allowDownload),
    passwordEnabled: Boolean(l.passwordEnabled),
    expiresAt: strOrNull(l.expiresAt),
    active: Boolean(l.active),
    status: strOrNull(l.status) ?? "active",
    createdVia: strOrNull(l.createdVia) ?? "api",
    createdAt: strOrNull(l.createdAt),
    lastViewedAt: strOrNull(l.lastViewedAt),
    viewCount: num(l.viewCount),
    downloadCount: num(l.downloadCount),
  };
}

/** Normalise one viewer row from the shareviews route (drops userId and per-page maps). */
/** `{ "3": 8146 }` — a page-number-keyed map of milliseconds, with anything unusable dropped. */
function pageTimeMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const page = Number(k);
    if (!Number.isFinite(page) || page < 1) continue;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[String(Math.floor(page))] = Math.floor(v);
  }
  return out;
}

function asViewer(raw: unknown): ShareViewsViewer {
  const v = rec(raw);
  return {
    name: strOrNull(v.name),
    email: strOrNull(v.email),
    views: num(v.views),
    timeSpentMs: num(v.timeSpentMs),
    pagesViewed: num(v.pagesViewed),
    pagesSeen: Array.isArray(v.pagesSeen) ? v.pagesSeen.filter((n): n is number => typeof n === "number") : [],
    pageTimeMsByPage: pageTimeMap(v.pageTimeMsByPage),
    firstSeen: strOrNull(v.firstSeen),
    lastSeen: strOrNull(v.lastSeen),
  };
}

export type ApiClientOptions = {
  baseUrl: string;
  key: string;
  /** Read per request so the attribution header can be updated once `initialize` names the client. */
  agent: () => string;
  timeoutMs?: number;
};

/** REST client bound to one API key and one agent identity. */
export class ApiClient {
  readonly baseUrl: string;
  private readonly key: string;
  private readonly agent: () => string;
  private readonly timeoutMs: number;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.key = opts.key;
    this.agent = opts.agent;
    this.timeoutMs = opts.timeoutMs ?? API_TIMEOUT_MS;
  }

  /** Public share URL for a doc. */
  shareUrl(shareId: string): string {
    return `${this.baseUrl}/s/${encodeURIComponent(shareId)}`;
  }

  /** Public project page (`/p/:shareId`): lists the project's documents whose links are on. */
  projectPublicUrl(shareId: string): string {
    return `${this.baseUrl}/p/${encodeURIComponent(shareId)}`;
  }

  /** The project's page inside the app, for the workspace's members. */
  projectAppUrl(projectId: string): string {
    return `${this.baseUrl}/project/${encodeURIComponent(projectId)}`;
  }

  /** Low-level request; throws `ToolError` on non-2xx, timeout or network failure. */
  async request<T = unknown>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, opts: { body?: unknown; query?: Query } = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.key}`,
          "x-lnkdrp-agent": this.agent(),
          "content-type": "application/json",
          accept: "application/json",
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
        redirect: "manual",
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      throw new ToolError(
        "upstream",
        aborted
          ? `lnkdrp API ${method} ${path} timed out after ${Math.round(this.timeoutMs / 1000)}s.`
          : `Could not reach the lnkdrp API at ${this.baseUrl} (${method} ${path}).`,
        { details: { path, method, reason: aborted ? "timeout" : "network" } },
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: text.slice(0, 200) };
      }
    }
    if (!res.ok) throw mapApiError({ status: res.status, body, method, path, siteUrl: this.baseUrl });
    return body as T;
  }

  /** `GET /api/agent/whoami` — also what registers the connection on the key. */
  async whoami(): Promise<Whoami> {
    const w = rec(await this.request("GET", "/api/agent/whoami"));
    const userId = strOrNull(w.userId);
    const orgId = strOrNull(w.orgId);
    if (!userId || !orgId) throw new ToolError("upstream", "lnkdrp whoami returned no workspace.");
    return {
      ok: true,
      userId,
      email: strOrNull(w.email),
      orgId,
      orgName: strOrNull(w.orgName),
      isPersonalOrg: Boolean(w.isPersonalOrg),
      plan: strOrNull(w.plan) ?? "free",
      keyPrefix: strOrNull(w.keyPrefix) ?? "",
      scopes: Array.isArray(w.scopes) ? w.scopes.filter((s): s is string => typeof s === "string") : [],
      client: strOrNull(w.client) ?? "",
    };
  }

  async createDoc(input: { title: string }): Promise<{ doc: ApiDoc; planWarning?: PlanWarning }> {
    const body = rec(await this.request("POST", "/api/docs", { body: input }));
    return { doc: asDoc(body.doc), planWarning: asPlanWarning(body.planWarning) };
  }

  async getDoc(docId: string): Promise<ApiDoc> {
    const body = rec(await this.request("GET", `/api/docs/${encodeURIComponent(docId)}`, { query: { lite: 1 } }));
    return asDoc(body.doc);
  }

  /** List docs matching `q` (title or shareId, case-insensitive substring). Archived docs are excluded by the API. */
  async listDocs(input: { q: string; limit?: number }): Promise<ApiDocListItem[]> {
    const page = await this.listDocsPage({ q: input.q, limit: input.limit ?? 50 });
    return page.docs.map((d) => ({ id: d.id, shareId: d.shareId, title: d.title, status: d.status }));
  }

  /**
   * `GET /api/docs` with its full contract: a title/slug search or a direct `ids` lookup, page-based.
   *
   * Page-based rather than cursor-based because that is what the route does; the tool mirrors it
   * faithfully instead of inventing a second pagination shape an agent would have to learn. `q`
   * matches a title or *any* of a document's share-link slugs (not only the default's, since
   * 4db0429). `ids` bypasses search and returns exactly those documents, in one call.
   */
  async listDocsPage(input: {
    q?: string | undefined;
    ids?: string[] | undefined;
    page?: number | undefined;
    limit?: number | undefined;
    /** true lists archived documents instead of live ones. */
    archived?: boolean | undefined;
  }): Promise<ApiDocsPage> {
    const body = rec(
      await this.request("GET", "/api/docs", {
        query: {
          q: input.q || undefined,
          ids: input.ids?.length ? input.ids.join(",") : undefined,
          page: input.page,
          limit: input.limit,
          archived: input.archived ? 1 : undefined,
        },
      }),
    );
    const docs = Array.isArray(body.docs) ? body.docs : [];
    return {
      total: num(body.total),
      page: num(body.page, 1),
      limit: num(body.limit),
      docs: docs.map((raw) => {
        const d = rec(raw);
        return {
          id: strOrNull(d.id) ?? "",
          shareId: strOrNull(d.shareId),
          title: strOrNull(d.title),
          status: strOrNull(d.status) ?? "draft",
          version: typeof d.version === "number" ? d.version : null,
          oneLiner: strOrNull(d.one_liner),
          previewImageUrl: strOrNull(d.previewImageUrl),
          createdDate: strOrNull(d.createdDate),
          updatedDate: strOrNull(d.updatedDate),
        };
      }),
    };
  }

  /**
   * `GET /api/activity` — the workspace feed, newest first, cursor-paginated.
   *
   * `who: "agents"` is the route's own filter for "anything an MCP or API client did, whoever owns
   * the key". It had been implemented and unused by every tool; it is exactly what an agent needs
   * to answer "what did I (or another agent) do here". Viewer identity on `share.viewed` /
   * `share.downloaded` rows is stripped server-side on Free, so the tool inherits the plan gate.
   */
  async listActivity(input: {
    limit?: number | undefined;
    cursor?: string | undefined;
    types?: string[] | undefined;
    docId?: string | undefined;
    who?: "me" | "team" | "agents" | undefined;
  }): Promise<ApiActivityPage> {
    const body = rec(
      await this.request("GET", "/api/activity", {
        query: {
          limit: input.limit,
          cursor: input.cursor,
          type: input.types?.length ? input.types.join(",") : undefined,
          docId: input.docId,
          who: input.who,
        },
      }),
    );
    const items = Array.isArray(body.items) ? body.items : [];
    return {
      nextCursor: strOrNull(body.nextCursor),
      items: items.map((raw) => {
        const r = rec(raw);
        const actor = rec(r.actor);
        const agent = r.agent ? rec(r.agent) : null;
        const doc = r.doc ? rec(r.doc) : null;
        const project = r.project ? rec(r.project) : null;
        return {
          id: strOrNull(r.id) ?? "",
          type: strOrNull(r.type) ?? "",
          createdDate: strOrNull(r.createdDate) ?? "",
          actor: { userId: strOrNull(actor.userId), name: strOrNull(actor.name), email: strOrNull(actor.email), kind: strOrNull(actor.kind) ?? "" },
          agent: agent ? { client: strOrNull(agent.client) ?? "", label: strOrNull(agent.label), version: strOrNull(agent.version) } : null,
          doc: doc ? { id: strOrNull(doc.id) ?? "", title: strOrNull(doc.title), shareId: strOrNull(doc.shareId) } : null,
          project: project ? { id: strOrNull(project.id) ?? "", name: strOrNull(project.name) } : null,
          meta: r.meta && typeof r.meta === "object" ? (r.meta as Record<string, unknown>) : {},
        };
      }),
    };
  }

  async patchDoc(docId: string, patch: DocPatch): Promise<{ doc: ApiDoc; planWarning?: PlanWarning }> {
    const body = rec(await this.request("PATCH", `/api/docs/${encodeURIComponent(docId)}`, { body: patch }));
    return { doc: asDoc(body.doc), planWarning: asPlanWarning(body.planWarning) };
  }

  async deleteDoc(docId: string): Promise<void> {
    await this.request("DELETE", `/api/docs/${encodeURIComponent(docId)}`);
  }

  /**
   * `GET /api/starred` — the key owner's starred documents in this workspace, in their sidebar order.
   * Stars are per person: they are the key creator's, not the workspace's.
   */
  async listStarred(): Promise<ApiStarredDoc[]> {
    const body = rec(await this.request("GET", "/api/starred"));
    return (Array.isArray(body.docs) ? body.docs : []).map((raw) => {
      const r = rec(raw);
      return { id: strOrNull(r.id) ?? "", title: strOrNull(r.title), starredAt: typeof r.starredAt === "number" && r.starredAt > 0 ? new Date(r.starredAt).toISOString() : null };
    });
  }

  /** `POST /api/starred { docId, starred }` — set one document's star (idempotent with `starred`). */
  async setStarred(docId: string, starred: boolean): Promise<ApiStarredDoc[]> {
    const body = rec(await this.request("POST", "/api/starred", { body: { docId, starred } }));
    return (Array.isArray(body.docs) ? body.docs : []).map((raw) => {
      const r = rec(raw);
      return { id: strOrNull(r.id) ?? "", title: strOrNull(r.title), starredAt: typeof r.starredAt === "number" && r.starredAt > 0 ? new Date(r.starredAt).toISOString() : null };
    });
  }

  /**
   * `GET /api/tags` — every tag in the workspace, alphabetical, with how many things carry each.
   */
  async listTags(): Promise<ApiTag[]> {
    const body = rec(await this.request("GET", "/api/tags"));
    return (Array.isArray(body.tags) ? body.tags : []).map(asTag);
  }

  /** `GET /api/tags/assignments` — the tags on one document or project. */
  /**
   * The tags on many things in one read — `GET /api/tags/targets`.
   *
   * The per-target endpoint above answers for one item; a list of twenty documents would be twenty
   * round trips, which is why the sidebar has this and why the list tools use it.
   */
  async tagsForTargets(input: { targetKind: "doc" | "project"; ids: string[] }): Promise<Map<string, ApiTag[]>> {
    const out = new Map<string, ApiTag[]>();
    const ids = [...new Set(input.ids.filter(Boolean))];
    if (!ids.length) return out;
    // The route caps at 200 ids; page rather than silently losing the tail.
    for (let i = 0; i < ids.length; i += 200) {
      const body = rec(
        await this.request("GET", "/api/tags/targets", {
          query: { targetKind: input.targetKind, ids: ids.slice(i, i + 200).join(",") },
        }),
      );
      const map = rec(body.tags);
      for (const [targetId, list] of Object.entries(map)) {
        out.set(targetId, (Array.isArray(list) ? list : []).map(asTag));
      }
    }
    return out;
  }

  /**
   * Everything carrying one tag — `GET /api/tags/by-slug/:slug/items`.
   *
   * Documents and projects together, because "fundraising" is one idea even when it is spread
   * across both. The slug is folded by the route, so any spelling of the name reaches the tag.
   */
  async itemsForTag(slug: string): Promise<{ tag: ApiTag; docIds: string[]; projectIds: string[] }> {
    const body = rec(await this.request("GET", `/api/tags/by-slug/${encodeURIComponent(slug)}/items`));
    const docs = Array.isArray(body.docs) ? body.docs : [];
    const projects = Array.isArray(body.projects) ? body.projects : [];
    return {
      tag: asTag(body.tag),
      docIds: docs.map((d) => strOrNull(rec(d).id) ?? "").filter(Boolean),
      projectIds: projects.map((p) => strOrNull(rec(p).id) ?? "").filter(Boolean),
    };
  }

  async tagsForTarget(input: { targetKind: "doc" | "project"; targetId: string }): Promise<ApiTag[]> {
    const body = rec(
      await this.request("GET", "/api/tags/assignments", {
        query: { targetKind: input.targetKind, targetId: input.targetId },
      }),
    );
    return (Array.isArray(body.tags) ? body.tags : []).map(asTag);
  }

  /**
   * `POST /api/tags/assignments` — attach a tag by name, creating it if the workspace has no such
   * tag yet. One call on purpose: find-or-create-then-attach in the client would race with itself.
   */
  async attachTag(input: {
    targetKind: "doc" | "project";
    targetId: string;
    name: string;
  }): Promise<{ tags: ApiTag[]; created: boolean }> {
    const body = rec(
      await this.request("POST", "/api/tags/assignments", {
        body: { targetKind: input.targetKind, targetId: input.targetId, name: input.name },
      }),
    );
    return {
      tags: (Array.isArray(body.tags) ? body.tags : []).map(asTag),
      created: Boolean(body.created),
    };
  }

  /** `DELETE /api/tags/assignments` — take one tag off one document or project. */
  async detachTag(input: {
    targetKind: "doc" | "project";
    targetId: string;
    tagId: string;
  }): Promise<ApiTag[]> {
    const body = rec(
      await this.request("DELETE", "/api/tags/assignments", {
        body: { targetKind: input.targetKind, targetId: input.targetId, tagId: input.tagId },
      }),
    );
    return (Array.isArray(body.tags) ? body.tags : []).map(asTag);
  }

  /** `GET /api/projects` — non-request projects, most recently updated first, page-based. */
  async listProjects(input: { q?: string | undefined; page?: number | undefined; limit: number }): Promise<ApiProjectsPage> {
    const body = rec(
      await this.request("GET", "/api/projects", { query: { q: input.q || undefined, page: input.page, limit: input.limit } }),
    );
    const rows = Array.isArray(body.projects) ? body.projects : [];
    return { total: num(body.total), page: num(body.page, 1), limit: num(body.limit, input.limit), projects: rows.map(asProject) };
  }

  /** `POST /api/projects` — 402 `plan_limit` at the Free project cap, 409 on a duplicate name. */
  async createProject(input: { name: string; description?: string | undefined }): Promise<{ project: ApiProject; planWarning?: PlanWarning }> {
    const body = rec(
      await this.request("POST", "/api/projects", {
        body: { name: input.name, ...(input.description !== undefined ? { description: input.description } : {}) },
      }),
    );
    return { project: asProject(body.project), planWarning: asPlanWarning(body.planWarning) };
  }

  /** `GET /api/projects/:id/docs` — the project (404 when not in this workspace) and a page of its documents. */
  async getProjectDocs(
    projectId: string,
    input: { q?: string | undefined; page?: number | undefined; limit: number; archived?: boolean | undefined },
  ): Promise<ApiProjectDocsPage> {
    const body = rec(
      await this.request("GET", `/api/projects/${encodeURIComponent(projectId)}/docs`, {
        query: { q: input.q || undefined, page: input.page, limit: input.limit, archived: input.archived ? 1 : undefined },
      }),
    );
    const rows = Array.isArray(body.docs) ? body.docs : [];
    return {
      project: asProject(body.project),
      total: num(body.total),
      page: num(body.page, 1),
      limit: num(body.limit, input.limit),
      docs: rows.map((raw) => {
        const d = rec(raw);
        return {
          id: strOrNull(d.id) ?? "",
          shareId: strOrNull(d.shareId),
          title: strOrNull(d.title),
          status: strOrNull(d.status) ?? "draft",
          version: typeof d.version === "number" ? d.version : null,
          previewImageUrl: strOrNull(d.previewImageUrl),
          createdDate: strOrNull(d.createdDate),
          updatedDate: strOrNull(d.updatedDate),
        };
      }),
    };
  }

  /**
   * `PATCH /api/projects/:id`. Pass `name` and the route rewrites description and autoAddFiles as
   * well, so a rename must carry their current values; `{ shareEnabled }` alone touches nothing else.
   */
  async updateProject(
    projectId: string,
    patch: { name: string; description: string; autoAddFiles: boolean; shareEnabled?: boolean | undefined } | { shareEnabled: boolean },
  ): Promise<ApiProject> {
    const body = rec(await this.request("PATCH", `/api/projects/${encodeURIComponent(projectId)}`, { body: patch }));
    return asProject(body.project);
  }

  /** `DELETE /api/projects/:id` — removes the project; its documents stay in the workspace. */
  async deleteProject(projectId: string): Promise<void> {
    await this.request("DELETE", `/api/projects/${encodeURIComponent(projectId)}`);
  }

  /** Set (`string`) or remove (`null`) the share password. */
  async setSharePassword(docId: string, password: string | null): Promise<{ sharePasswordEnabled: boolean }> {
    const body = rec(await this.request("POST", `/api/docs/${encodeURIComponent(docId)}/share-password`, { body: { password } }));
    return { sharePasswordEnabled: Boolean(body.sharePasswordEnabled) };
  }

  /**
   * `GET /api/docs/:id/links` — every link of a document, default first, or (with `query`) only
   * the ones matching it by label/audience, ranked by relevance (mt_9ceLy7DqEr).
   */
  async listShareLinks(docId: string, query?: string | undefined): Promise<ApiShareLink[]> {
    return (await this.listShareLinksPage(docId, query)).links;
  }

  /**
   * The same route, with the figure that says whether you got all of it.
   *
   * `GET /api/docs/:id/links` is page-based — default 25, max 100 — and this client was sending
   * neither `page` nor `limit` and discarding `total`. A document with more than 25 links quietly
   * lost the tail, and every caller above treated the answer as "every link on this document":
   * `get_share` looked for the default link in it, `delete_doc` counted live links from it to
   * decide how loudly to confirm. Asking for the maximum does not make the truncation impossible,
   * so the count comes back too and the callers say "25 of 40" rather than implying completeness.
   */
  async listShareLinksPage(
    docId: string,
    query?: string | undefined,
  ): Promise<{ links: ApiShareLink[]; total: number; truncated: boolean }> {
    const body = rec(
      await this.request("GET", `/api/docs/${encodeURIComponent(docId)}/links`, {
        query: { q: query || undefined, limit: 100 },
      }),
    );
    const links = Array.isArray(body.links) ? body.links.map(asShareLink) : [];
    const total = typeof body.total === "number" ? body.total : links.length;
    return { links, total, truncated: total > links.length };
  }

  /**
   * `GET /api/share-links?q=` — full-text search for a link across the whole workspace by
   * label/audience, when the caller does not already know which document it is on
   * (mt_9ceLy7DqEr). The counterpart to `listShareLinks`'s scoped `query` above.
   */
  async findShareLinks(query: string, limit?: number | undefined): Promise<ApiShareLinkSearchHit[]> {
    const body = rec(await this.request("GET", "/api/share-links", { query: { q: query, limit } }));
    const rows = Array.isArray(body.links) ? body.links : [];
    return rows.map((raw) => {
      const r = rec(raw);
      return {
        // A workspace search now returns project links too (they live in the same collection), and
        // they have no document: docId stays null rather than "" so nothing feeds an empty id back
        // into a docId parameter.
        kind: strOrNull(r.kind) === "project" ? "project" : "doc",
        docId: strOrNull(r.docId),
        docTitle: strOrNull(r.docTitle),
        docShareId: strOrNull(r.docShareId),
        projectId: strOrNull(r.projectId),
        projectName: strOrNull(r.projectName),
        linkId: strOrNull(r.linkId) ?? "",
        shareId: strOrNull(r.shareId) ?? "",
        label: strOrNull(r.label) ?? "",
        audience: strOrNull(r.audience),
        isDefault: Boolean(r.isDefault),
        enabled: r.enabled !== false,
        expiresAt: strOrNull(r.expiresAt),
        status: strOrNull(r.status) ?? (r.enabled === false ? "disabled" : "active"),
      };
    });
  }

  /**
   * `POST /api/docs/:id/links` — create a link. Links are never plan-capped: the link always comes
   * back enabled (201). `planWarning` is only a heads-up that the workspace is near its separate
   * cap on shared *documents*. It used to say the link was "created disabled at the cap" — the
   * wording of the bug 1ce4413 removed, kept out of here so nobody wires it back in.
   */
  async createShareLink(docId: string, settings: ShareLinkPatch & { label: string }): Promise<{ link: ApiShareLink; planWarning?: PlanWarning }> {
    const body = rec(await this.request("POST", `/api/docs/${encodeURIComponent(docId)}/links`, { body: settings }));
    return { link: asShareLink(body.link), planWarning: asPlanWarning(body.planWarning) };
  }

  /** `PATCH /api/docs/:id/links/:linkId` — change one link's settings. */
  async updateShareLink(
    docId: string,
    linkId: string,
    patch: ShareLinkPatch,
  ): Promise<{ link: ApiShareLink; planWarning?: PlanWarning; warnings: string[] }> {
    const body = rec(
      await this.request("PATCH", `/api/docs/${encodeURIComponent(docId)}/links/${encodeURIComponent(linkId)}`, { body: patch }),
    );
    return {
      link: asShareLink(body.link),
      planWarning: asPlanWarning(body.planWarning),
      // The route reports when enabling this link re-shared the document and brought its other
      // links back with it. Dropping that here made a change to who can reach the document
      // invisible to the agent that caused it.
      warnings: Array.isArray(body.warnings) ? body.warnings.filter((w): w is string => typeof w === "string") : [],
    };
  }

  /**
   * `GET /api/docs/:id/links/:linkId/password` — the password set on a link, in plain text.
   *
   * `password` is null when the link has none, and also when the link predates encryption at rest
   * and only its hash survives — `passwordEnabled` separates those two cases. The route writes an
   * activity row on every successful read.
   */
  async getShareLinkPassword(docId: string, linkId: string): Promise<{ passwordEnabled: boolean; password: string | null }> {
    const body = rec(
      await this.request("GET", `/api/docs/${encodeURIComponent(docId)}/links/${encodeURIComponent(linkId)}/password`),
    );
    return { passwordEnabled: Boolean(body.passwordEnabled), password: strOrNull(body.password) };
  }

  /**
   * `POST /api/docs/:id/links/:linkId/password/verify` — does this password open this link?
   *
   * Never the recipient's unlock route: that would set a share cookie, record a view, and spend
   * the recipient's 10-attempts-per-5-minutes budget on a check they did not make.
   */
  async verifyShareLinkPassword(docId: string, linkId: string, password: string): Promise<{ passwordEnabled: boolean; matches: boolean }> {
    const body = rec(
      await this.request("POST", `/api/docs/${encodeURIComponent(docId)}/links/${encodeURIComponent(linkId)}/password/verify`, {
        body: { password },
      }),
    );
    return { passwordEnabled: Boolean(body.passwordEnabled), matches: Boolean(body.matches) };
  }

  /** `DELETE /api/docs/:id/links/:linkId` — soft-archive a link (204; analytics are kept). */
  async deleteShareLink(docId: string, linkId: string): Promise<void> {
    await this.request("DELETE", `/api/docs/${encodeURIComponent(docId)}/links/${encodeURIComponent(linkId)}`);
  }

  /**
   * `GET /api/projects/:id/links` — every link of a project, default first then newest, or (with
   * `query`) only those matching it by label/audience.
   *
   * The route is page-based where the document one is not, so this asks for 100 in one go: a
   * project is capped at 50 live links (`SHARE_LINKS_PER_PROJECT_MAX`), which makes one page always
   * the whole set and spares every caller a paging loop it would get wrong once.
   */
  async listProjectLinks(projectId: string, query?: string | undefined): Promise<ApiProjectLink[]> {
    const body = rec(
      await this.request("GET", `/api/projects/${encodeURIComponent(projectId)}/links`, { query: { q: query || undefined, limit: 100 } }),
    );
    return Array.isArray(body.links) ? body.links.map(asProjectLink) : [];
  }

  /**
   * `POST /api/projects/:id/links` — create a link on a project. **Pro only**, unlike document
   * links: on Free the route answers `402 { code: "plan_limit", limit: "project_links" }` and
   * writes nothing, so there is no `planWarning` half-state to report here.
   */
  async createProjectLink(projectId: string, settings: ProjectLinkPatch & { label: string }): Promise<ApiProjectLink> {
    const body = rec(await this.request("POST", `/api/projects/${encodeURIComponent(projectId)}/links`, { body: settings }));
    return asProjectLink(body.link);
  }

  /** `PATCH /api/projects/:id/links/:linkId` — change one project link's settings. */
  async updateProjectLink(
    projectId: string,
    linkId: string,
    patch: ProjectLinkPatch,
  ): Promise<{ link: ApiProjectLink; warnings: string[] }> {
    const body = rec(
      await this.request("PATCH", `/api/projects/${encodeURIComponent(projectId)}/links/${encodeURIComponent(linkId)}`, { body: patch }),
    );
    return {
      link: asProjectLink(body.link),
      // Enabling a project link can republish the room's public page and restore every link that
      // page switch had taken down. The route says so; dropping it here left the same silence the
      // document version was fixed for, on the surface where one link is the whole data room.
      warnings: Array.isArray(body.warnings) ? body.warnings.filter((w): w is string => typeof w === "string") : [],
    };
  }

  /** `DELETE /api/projects/:id/links/:linkId` — soft-archive a project link (204; analytics kept). */
  async deleteProjectLink(projectId: string, linkId: string): Promise<void> {
    await this.request("DELETE", `/api/projects/${encodeURIComponent(projectId)}/links/${encodeURIComponent(linkId)}`);
  }

  async createUpload(input: { docId: string; originalFileName: string; summary?: string | undefined; keyPoints?: string[] | undefined }): Promise<ApiUpload> {
    const body = rec(
      await this.request("POST", "/api/uploads", {
        body: {
          docId: input.docId,
          originalFileName: input.originalFileName,
          contentType: "application/pdf",
          sizeBytes: 0,
          // Agent-written summary: both or neither (the server skips the paid AI summary when present).
          ...(input.summary !== undefined && input.keyPoints !== undefined ? { summary: input.summary, keyPoints: input.keyPoints } : {}),
        },
      }),
    );
    const u = rec(body.upload);
    const id = strOrNull(u.id);
    if (!id) throw new ToolError("upstream", "lnkdrp API returned an upload without an id.");
    return { id, docId: strOrNull(u.docId) ?? input.docId, version: typeof u.version === "number" ? u.version : null, status: strOrNull(u.status) ?? "uploading" };
  }

  async importUrl(uploadId: string, url: string): Promise<void> {
    await this.request("POST", `/api/uploads/${encodeURIComponent(uploadId)}/import-url`, { body: { url } });
  }

  /**
   * `POST /api/uploads/:id/import-bytes` — attach a PDF sent as inline base64 instead of fetched
   * from a URL. mt_bJwX4CtmhU: what `lnkdrp_share_pdf`/`lnkdrp_replace_pdf` call when the caller
   * passed `fileBase64` instead of `sourceUrl`. Capped well under Vercel's request-body limit; see
   * the route for exactly why.
   */
  async importBytes(uploadId: string, contentBase64: string, fileName?: string | undefined): Promise<void> {
    await this.request("POST", `/api/uploads/${encodeURIComponent(uploadId)}/import-bytes`, { body: { contentBase64, fileName } });
  }

  async processUpload(uploadId: string): Promise<{ alreadyProcessing: boolean }> {
    const body = rec(await this.request("POST", `/api/uploads/${encodeURIComponent(uploadId)}/process`));
    return { alreadyProcessing: Boolean(body.alreadyProcessing) };
  }

  /** `GET /api/uploads/:id` — upload status plus the AI outcome (`ai` is null until processing finishes). */
  async getUpload(uploadId: string): Promise<{ id: string; status: string | null; ai: UploadAi | null; error: string | null }> {
    const body = rec(await this.request("GET", `/api/uploads/${encodeURIComponent(uploadId)}`));
    const u = rec(body.upload);
    return { id: strOrNull(u.id) ?? uploadId, status: strOrNull(u.status), ai: asUploadAi(u.ai), error: strOrNull(u.error) };
  }

  /** `GET /api/credits/snapshot?fast=1` — credits left in the workspace (read defensively). */
  async creditsSnapshot(): Promise<CreditsSnapshotLite> {
    const s = rec(await this.request("GET", "/api/credits/snapshot", { query: { fast: 1 } }));
    const resetAt = strOrNull(s.resetAt) ?? strOrNull(s.creditsResetAt) ?? strOrNull(s.resetsAt) ?? strOrNull(s.nextResetAt) ?? strOrNull(s.cycleEnd);
    return {
      creditsRemaining: typeof s.creditsRemaining === "number" ? s.creditsRemaining : null,
      blocked: Boolean(s.blocked),
      includedThisCycle: typeof s.includedThisCycle === "number" ? s.includedThisCycle : null,
      cycleEnd: strOrNull(s.cycleEnd),
      resetAt,
      onDemandEnabled: Boolean(s.onDemandEnabled),
    };
  }

  /**
   * `GET /api/plan` — the workspace plan plus its caps and current usage. `limit: null` means
   * unlimited (Pro). Powers `lnkdrp_whoami`'s `capabilities`, not just its bare `plan` string.
   */
  async planSnapshot(): Promise<PlanSnapshotLite> {
    const p = rec(await this.request("GET", "/api/plan"));
    const limits = rec(p.limits);
    const usage = rec(p.usage);
    const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return {
      plan: strOrNull(p.plan),
      limits: { documents: n(limits.documents), projects: n(limits.projects), analyticsDays: n(limits.analyticsDays), collaborators: n(limits.collaborators) },
      usage: { documents: n(usage.documents) ?? 0, projects: n(usage.projects) ?? 0, members: n(usage.members) ?? 0 },
    };
  }

  /** Analytics for a document, or for one of its links when `shareId` is given. */
  async shareViews(docId: string, input: { days: number; viewers: boolean; shareId?: string | undefined }): Promise<ShareViews> {
    const body = rec(
      await this.request("GET", `/api/docs/${encodeURIComponent(docId)}/shareviews`, {
        query: { days: input.days, viewers: input.viewers ? 1 : undefined, shareId: input.shareId },
      }),
    );
    const totals = rec(body.totals);
    const series = Array.isArray(body.series) ? body.series : [];
    return {
      days: num(body.days, input.days),
      analyticsDaysLimit: typeof body.analyticsDaysLimit === "number" ? body.analyticsDaysLimit : null,
      analyticsTier: strOrNull(body.analyticsTier) ?? "basic",
      viewerCount: num(body.viewerCount),
      totals: {
        views: num(totals.views),
        ownerPreviews: num(totals.ownerPreviews),
        opens: num(totals.opens),
        opensPartial: totals.opensPartial === true,
        downloads: num(totals.downloads),
        pagesViewed: num(totals.pagesViewed),
        timeSpentMs: num(totals.timeSpentMs),
        authenticatedViewers: num(totals.authenticatedViewers),
        anonymousViewers: num(totals.anonymousViewers),
      },
      series: series.map((raw) => {
        const s = rec(raw);
        // `opens` joined the route's series on 2026-09-16 and this mapper whitelists fields, so
        // without it agents saw a daily `views` line and a total `opens` they could not break down.
        return { date: strOrNull(s.date) ?? "", views: num(s.views), opens: num(s.opens), downloads: num(s.downloads) };
      }),
      viewers: Array.isArray(body.viewers) ? body.viewers.map(asViewer) : [],
      anonymousViewers: Array.isArray(body.anonymousViewers) ? body.anonymousViewers.map(asViewer) : [],
      // Whitelisted like everything else here, which is exactly how it went missing: the route
      // added this section so that "who read this document" stops answering "nobody" while the
      // activity feed names someone, and the mapper below silently dropped it.
      projectLinkTraffic: asProjectLinkTraffic(body.projectLinkTraffic),
      totalsAllTime: (() => {
        if (!body.totalsAllTime || typeof body.totalsAllTime !== "object") return null;
        const t = rec(body.totalsAllTime);
        return {
          views: num(t.views),
          ownerPreviews: num(t.ownerPreviews),
          opens: num(t.opens),
          opensPartial: t.opensPartial === true,
          downloads: num(t.downloads),
          pagesViewed: num(t.pagesViewed),
        };
      })(),
      lastViewedAt: strOrNull(body.lastViewedAt),
    };
  }
}

/** Normalise the project-link section, or null when the route omitted it (no such traffic). */
function asProjectLinkTraffic(raw: unknown): ProjectLinkTraffic | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const t = rec(raw);
  const links = Array.isArray(t.links) ? t.links : [];
  const viewerRows = Array.isArray(t.viewerRows) ? t.viewerRows : [];
  return {
    views: num(t.views),
    viewers: num(t.viewers),
    links: links.map((rawLink) => {
      const l = rec(rawLink);
      return {
        shareId: strOrNull(l.shareId) ?? "",
        label: strOrNull(l.label),
        projectId: strOrNull(l.projectId),
        projectName: strOrNull(l.projectName),
        views: num(l.views),
        viewers: num(l.viewers),
        lastViewedAt: strOrNull(l.lastViewedAt),
      };
    }),
    viewerRows: viewerRows.map((rawRow) => {
      const v = rec(rawRow);
      return {
        shareId: strOrNull(v.shareId) ?? "",
        projectId: strOrNull(v.projectId),
        projectName: strOrNull(v.projectName),
        views: num(v.views),
        pagesViewed: num(v.pagesViewed),
        timeSpentMs: num(v.timeSpentMs),
        lastViewedAt: strOrNull(v.lastViewedAt),
        viewerName: strOrNull(v.viewerName),
        viewerEmail: strOrNull(v.viewerEmail),
      };
    }),
  };
}
