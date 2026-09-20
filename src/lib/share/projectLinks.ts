/**
 * Project share links service — the project-shaped half of `ShareLink`
 * (docs/prds/lnkdrp-project-links.md, milestone M1).
 *
 * A project owns any number of public links, each with its own label, audience, password, expiry
 * and download setting, all resolving to `/p/:shareId`. This file is the only place that creates,
 * lists, updates, resolves and counts them, exactly as `./links.ts` is for documents.
 *
 * Why a sibling file rather than more of `links.ts`: that module is 700 lines of document
 * vocabulary — `DocLike`, `DOC_SHARE_FIELDS`, `syncDocShareState`, the revision-history Pro gate —
 * and every one of its queries has to stay provably document-only after this change. Splitting the
 * two makes "which functions can see a project link" a question you answer by looking at the import
 * list. The genuinely shared pieces (validation, password material, the active/expired rules, the
 * error type) are imported from `./links.ts` rather than copied, so the two kinds cannot drift on
 * what a valid label or a real expiry date is.
 *
 * Two rules that differ from document links:
 * - **Pro only.** `createProjectLink` is the first link-create in the product that a plan can
 *   refuse (`project_links`, a feature gate). Free keeps the project's single default link, which
 *   `ensureDefaultProjectLink` materialises rather than creates, so no existing `/p/:shareId` in
 *   anyone's inbox stops working when a workspace drops to Free.
 * - **No `allowRevisionHistory`.** A project link has no single document whose versions it could
 *   list; the field stays false on every project row.
 */
import { Types, type ProjectionType } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { ProjectModel } from "@/lib/models/Project";
import { PROJECT_LINK_FILTER, ShareLinkModel, type ShareLink } from "@/lib/models/ShareLink";
import { ShareViewModel } from "@/lib/models/ShareView";
import { newShareId } from "@/lib/crypto/randomBase62";
import { PROJECT_LINK_VIEWER_KEY_EXPR } from "@/lib/analytics/project/viewerKey";
import { ensurePersonalOrgForUserId } from "@/lib/models/Org";
import { checkLimit, type LimitCheck } from "@/lib/billing/planLimits";
import {
  DEFAULT_LINK_LABEL,
  ShareLinkError,
  isExpired,
  isLinkActive,
  passwordFields,
  validateAudience,
  validateExpiry,
  validateLabel,
  type ShareLinkSettingsInput,
  type ShareLinkStats,
} from "./links";
import { switchMayRestore } from "@/lib/share/links";

/**
 * Runaway guard, not a plan limit — the same role `SHARE_LINKS_PER_DOC_MAX` plays for documents.
 * The plan decision happens in `createProjectLink` before this is ever reached.
 */
export const SHARE_LINKS_PER_PROJECT_MAX = 50;

/** Field shape this service needs from a Project (lean or hydrated). */
export type ProjectLike = {
  _id: Types.ObjectId;
  orgId?: Types.ObjectId | null;
  userId?: Types.ObjectId | null;
  name?: string | null;
  shareId?: string | null;
  shareEnabled?: boolean | null;
  isDeleted?: boolean | null;
};

const PROJECT_SHARE_FIELDS = {
  _id: 1,
  orgId: 1,
  userId: 1,
  name: 1,
  shareId: 1,
  shareEnabled: 1,
  isDeleted: 1,
} as const;

/** Coerce a string id to an ObjectId, passing an ObjectId straight through. */
function oid(v: string | Types.ObjectId): Types.ObjectId {
  return v instanceof Types.ObjectId ? v : new Types.ObjectId(v);
}

/**
 * One project link as the API hands it out.
 *
 * Deliberately not `ShareLinkDTO`: a project link has no `docId` and no `allowRevisionHistory`, and
 * a DTO that carries both as permanent nulls invites a client to render a revision-history toggle
 * that can never be turned on.
 */
export type ProjectLinkDTO = {
  id: string;
  projectId: string;
  shareId: string;
  label: string;
  audience: string | null;
  /** The project's original link (`Project.shareId`); listed first and never deletable. */
  isDefault: boolean;
  enabled: boolean;
  /** Applies to every document opened through this link (PRD decision 3). */
  allowDownload: boolean;
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

/**
 * Recompute traffic for a set of project links, from the analytics rows.
 *
 * Unlike the document version this matches on `shareId` alone — a project link has no `docId` to
 * scope by, and its rows are spread across every document a recipient opened through it. The
 * `isOwnerPreview` and `lastViewedAt`-or-`updatedDate` rules are the same two every other read path
 * applies, so these numbers reconcile with the document metrics page for the same visits.
 *
 * `viewCount` is **recipients**, the same quantity the field carries on a document link — not the
 * row count. A project link writes one `ShareView` per (viewer, document), so counting rows made
 * `/links` report 4 for the link whose own metrics page, workspace card and MCP stats all said 3:
 * one investor who opened a deck and a term sheet was two "views" in one column and one reader in
 * every other. Hence the two-stage group on `PROJECT_LINK_VIEWER_KEY_EXPR` — collapse (viewer ×
 * document) to the viewer, then count the buckets — which is exactly what
 * `/api/projects/:id/shareviews` does, so the two cannot drift. "How many documents were opened"
 * remains available from the project metrics page, where it is labelled as such.
 */
export async function projectLinkStatsByShareId(shareIds: string[]): Promise<Map<string, ShareLinkStats>> {
  const out = new Map<string, ShareLinkStats>();
  if (!shareIds.length) return out;
  await connectMongo();
  const rows = (await ShareViewModel.aggregate([
    { $match: { shareId: { $in: shareIds }, isOwnerPreview: { $ne: true } } },
    // Stage 1: one bucket per (link, viewer) — the composite `botIdHash` a project link writes
    // carries the document, so this is where the document is dropped and the reader kept.
    {
      $group: {
        _id: PROJECT_LINK_VIEWER_KEY_EXPR,
        downloadCount: { $sum: { $ifNull: ["$downloads", 0] } },
        lastViewedAt: { $max: { $ifNull: ["$lastViewedAt", "$updatedDate"] } },
      },
    },
    // Stage 2: count those buckets per link. Downloads and `lastViewedAt` are unaffected by the
    // regrouping — a sum of sums and a max of maxes.
    {
      $group: {
        _id: "$_id.shareId",
        viewCount: { $sum: 1 },
        downloadCount: { $sum: "$downloadCount" },
        lastViewedAt: { $max: "$lastViewedAt" },
      },
    },
  ])) as Array<{ _id: string; viewCount?: number; downloadCount?: number; lastViewedAt?: Date | null }>;
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
 * @param stats Recomputed traffic from {@link projectLinkStatsByShareId}. When omitted the link's
 * own counters are used, which is right for a link that was just created and has no rows yet.
 */
export function toProjectLinkDTO(link: ShareLink, stats?: ShareLinkStats | null): ProjectLinkDTO {
  const status: ProjectLinkDTO["status"] = link.archivedAt ? "archived" : !link.enabled ? "disabled" : isExpired(link) ? "expired" : "active";
  return {
    id: String(link._id),
    projectId: String(link.projectId),
    shareId: link.shareId,
    label: link.label,
    audience: link.audience ?? null,
    isDefault: Boolean(link.isDefault),
    enabled: Boolean(link.enabled),
    allowDownload: Boolean(link.allowDownload),
    passwordEnabled: Boolean(link.passwordHash),
    expiresAt: link.expiresAt ? link.expiresAt.toISOString() : null,
    active: status === "active",
    status,
    createdVia: link.createdVia ?? "web",
    createdAt: link.createdDate ? link.createdDate.toISOString() : new Date(0).toISOString(),
    lastViewedAt: stats ? (stats.lastViewedAt ? stats.lastViewedAt.toISOString() : null) : link.lastViewedAt ? link.lastViewedAt.toISOString() : null,
    viewCount: stats ? stats.viewCount : link.viewCount ?? 0,
    downloadCount: stats ? stats.downloadCount : link.downloadCount ?? 0,
  };
}

/**
 * Materialise the default link for a project that predates the model, adopting its `Project.shareId`
 * so every `/p/:shareId` already in someone's inbox keeps resolving — no migration day, exactly the
 * bargain `ensureDefaultLink()` struck for documents.
 *
 * Idempotent, and free on Free: this is a backfill of a link that already exists in the world, not
 * a create, so it never consults the plan.
 *
 * `allowDownload` starts **false**, matching a freshly created link. Today the project page sends
 * recipients to `/s/:docShareId`, where each document's own download setting governs; from M2 the
 * project link's flag governs instead (PRD decision 3), and starting it off is the direction that
 * cannot hand out a PDF nobody meant to release. Owners who want downloads switch them on per link.
 */
export async function ensureDefaultProjectLink(
  project: ProjectLike,
  opts: { createdVia?: "web" | "api" | "mcp" | "default" } = {},
): Promise<ShareLink | null> {
  await connectMongo();
  const existing = await ShareLinkModel.findOne({ projectId: project._id, isDefault: true }).lean<ShareLink>();
  if (existing) return existing;
  // `ShareLink.orgId` is `required: true`, so a project that predates workspaces — no `orgId`, only
  // a `userId` — used to make this a *throw* rather than a backfill, and the throw surfaced on the
  // public `/p/:shareId` as a 500 for a recipient holding a perfectly good legacy link. Adopt the
  // project into its owner's personal workspace instead, the same move
  // `accessProjectForLinks` makes on the owner side, and write the id back so it happens once.
  let orgId = project.orgId ?? null;
  if (!orgId && project.userId) {
    try {
      orgId = (await ensurePersonalOrgForUserId({ userId: oid(project.userId) })).orgId;
      await ProjectModel.updateOne({ _id: project._id }, { $set: { orgId } });
    } catch {
      orgId = null;
    }
  }
  // Nothing to adopt it into (no owner either): return empty-handed rather than throw, so the
  // caller falls back to the legacy `Project.shareId` render instead of 500-ing.
  if (!orgId) return null;
  let shareId = (project.shareId && String(project.shareId).trim()) || newShareId();
  const byShareId = await ShareLinkModel.findOne({ shareId }).lean<ShareLink>();
  // `Project.shareId` and `Doc.shareId` are unique within their own collections but nothing
  // enforces uniqueness across the two, so a project's slug can already be taken by a document
  // link. Mint a fresh one and re-point the project rather than let the unique index refuse the
  // insert (which would leave the project with no default link at all).
  if (byShareId && !byShareId.projectId) shareId = newShareId();
  else if (byShareId) return byShareId;
  try {
    const created = await ShareLinkModel.create({
      orgId,
      projectId: project._id,
      docId: null,
      kind: "project",
      shareId,
      label: DEFAULT_LINK_LABEL,
      audience: null,
      isDefault: true,
      enabled: project.shareEnabled !== false,
      allowDownload: false,
      allowRevisionHistory: false,
      expiresAt: null,
      createdByUserId: project.userId ?? null,
      // Only a deliberate create knows who made it. Everything else here is this project's own
      // default link being materialised on first read — `default`, not `migration`, which belongs
      // to rows the backfill script brought forward from before the link model existed.
      createdVia: opts.createdVia ?? "default",
    });
    if (project.shareId !== shareId) await ProjectModel.updateOne({ _id: project._id }, { $set: { shareId } });
    return created.toObject() as ShareLink;
  } catch (e) {
    // Lost a race on the unique index: return whichever row won.
    const again = await ShareLinkModel.findOne({ $or: [{ shareId }, { projectId: project._id, isDefault: true }] }).lean<ShareLink>();
    if (again) return again;
    throw e;
  }
}

export type ResolvedProjectLink = {
  link: ShareLink;
  project: ProjectLike & Record<string, unknown>;
  /** Why a public route must refuse, or null when the link may be served. */
  refusal: null | "disabled" | "expired" | "archived" | "project_gone";
};

/**
 * Turn a public slug into its project link and project — the `/p/:shareId` counterpart of
 * `resolveShareLink`, and the only way that tree is allowed to read a slug.
 *
 * Falls back to `Project.shareId` for projects with no link row yet (materialising their default),
 * so a link shared before this feature existed resolves on its first visit. Returns null when the
 * slug is unknown **or** when it belongs to a document link: the two trees share one slug namespace
 * and each refuses the other's slugs, so `/p/<a document slug>` is a 404 rather than a redirect
 * that would leak which documents exist.
 */
export async function resolveProjectLink(shareId: string, opts: { select?: Record<string, 1> } = {}): Promise<ResolvedProjectLink | null> {
  const slug = (shareId || "").trim();
  if (!slug) return null;
  await connectMongo();
  let link = await ShareLinkModel.findOne({ shareId: slug }).lean<ShareLink>();
  if (link && !link.projectId) return null;
  let project: (ProjectLike & Record<string, unknown>) | null = null;
  if (link) {
    project = (await ProjectModel.findOne({ _id: link.projectId })
      .select({ ...PROJECT_SHARE_FIELDS, ...(opts.select ?? {}) })
      .lean()) as (ProjectLike & Record<string, unknown>) | null;
  } else {
    project = (await ProjectModel.findOne({ shareId: slug })
      .select({ ...PROJECT_SHARE_FIELDS, ...(opts.select ?? {}) })
      .lean()) as (ProjectLike & Record<string, unknown>) | null;
    if (!project) return null;
    link = await ensureDefaultProjectLink(project);
    // No link could be materialised (a project with neither workspace nor owner). The slug is real
    // but there is nothing to serve it with, so this is a 404, never a 500.
    if (!link) return null;
  }
  if (!project || project.isDeleted) {
    return link ? { link, project: project ?? ({ _id: link.projectId } as ProjectLike & Record<string, unknown>), refusal: "project_gone" } : null;
  }
  const refusal: ResolvedProjectLink["refusal"] = link.archivedAt ? "archived" : !link.enabled ? "disabled" : isExpired(link) ? "expired" : null;
  return { link, project, refusal };
}

/**
 * Resolve a project inside a workspace, with the same legacy fallback the project routes use:
 * projects created before workspaces have no `orgId` and are matched by their owner's `userId`.
 */
async function findProject(input: { orgId: string | Types.ObjectId; projectId: string | Types.ObjectId }): Promise<ProjectLike | null> {
  return (await ProjectModel.findOne({ _id: oid(input.projectId), orgId: oid(input.orgId), isDeleted: { $ne: true } })
    .select(PROJECT_SHARE_FIELDS)
    .lean()) as ProjectLike | null;
}

/**
 * Links of one project, default first then newest first. Archived links are excluded unless asked.
 *
 * **Read-only.** It used to call `ensureDefaultProjectLink` first, which made every GET that listed
 * links — the links panel, the metrics route, a single link's detail route — a path that could
 * create a `ShareLink` and rewrite `Project.shareId` as a side effect. Materialising the default
 * link is a write, and it belongs on the write paths (`createProjectLink`,
 * `setAllProjectLinksEnabled`), on the project page load (`GET /api/projects/:id/docs`, which
 * already backfills the project's slug there) and on the public resolve (`resolveProjectLink`), all
 * of which call it explicitly.
 */
export async function listProjectLinks(input: {
  orgId: string | Types.ObjectId;
  projectId: string | Types.ObjectId;
  includeArchived?: boolean;
}): Promise<ShareLink[]> {
  await connectMongo();
  const project = await findProject(input);
  if (!project) return [];
  const filter: Record<string, unknown> = { projectId: oid(input.projectId), ...PROJECT_LINK_FILTER };
  if (!input.includeArchived) filter.archivedAt = null;
  const rows = await ShareLinkModel.find(filter).lean<ShareLink[]>();
  return rows.sort((a, b) => (a.isDefault === b.isDefault ? (b.createdDate?.getTime() ?? 0) - (a.createdDate?.getTime() ?? 0) : a.isDefault ? -1 : 1));
}

/**
 * The page-based counterpart of `listProjectLinks`, for the links panel a person scrolls.
 *
 * Same contract as `listShareLinksPage`: sort/skip/limit in Mongo so the row count reaching Node is
 * `limit`, and `?q=` full-text searches this project's links by label/audience (ranked by
 * relevance, `page` ignored) through the one text index `sharelinks` carries.
 */
export async function listProjectLinksPage(input: {
  orgId: string | Types.ObjectId;
  projectId: string | Types.ObjectId;
  includeArchived?: boolean;
  page?: number;
  limit?: number;
  query?: string;
}): Promise<{ total: number; page: number; limit: number; links: ShareLink[] }> {
  await connectMongo();
  const page = Number.isFinite(input.page) && (input.page ?? 0) >= 1 ? Math.floor(input.page!) : 1;
  const limit = Number.isFinite(input.limit) && (input.limit ?? 0) >= 1 ? Math.min(100, Math.floor(input.limit!)) : 25;
  const project = await findProject(input);
  if (!project) return { total: 0, page, limit, links: [] };
  // Read-only, like `listProjectLinks` above — and more so: `?q=` fires this on every keystroke.
  const query = (input.query ?? "").trim();
  const filter: Record<string, unknown> = { projectId: oid(input.projectId), ...PROJECT_LINK_FILTER };
  if (!input.includeArchived) filter.archivedAt = null;

  if (query) {
    Object.assign(filter, { $text: { $search: query } });
    // `score` isn't a schema field; Mongoose's projection typing has no slot for a `$meta`
    // projection, hence the cast. `.sort()` accepts `{ $meta }` natively and needs none.
    const rows = await ShareLinkModel.find(filter, { score: { $meta: "textScore" } } as unknown as ProjectionType<ShareLink>)
      .sort({ score: { $meta: "textScore" } })
      .limit(limit)
      .lean<ShareLink[]>();
    return { total: rows.length, page: 1, limit, links: rows };
  }

  const [total, rows] = await Promise.all([
    ShareLinkModel.countDocuments(filter),
    ShareLinkModel.find(filter)
      .sort({ isDefault: -1, createdDate: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean<ShareLink[]>(),
  ]);
  return { total, page, limit, links: rows };
}

/**
 * Keep `Project.shareEnabled` equal to "this project has at least one active link", and
 * `Project.shareId` pointing at the default one.
 *
 * The mirror of `syncDocShareState`. `/p/:shareId` and `ProjectSharePanel` both still read the
 * legacy Project fields, so a link change that did not write them back would show an owner a switch
 * that disagreed with what recipients see.
 */
export async function syncProjectShareState(projectId: string | Types.ObjectId): Promise<void> {
  await connectMongo();
  const id = oid(projectId);
  const links = await ShareLinkModel.find({ projectId: id, ...PROJECT_LINK_FILTER, archivedAt: null }).lean<ShareLink[]>();
  const anyActive = links.some((l) => isLinkActive(l));
  const def = links.find((l) => l.isDefault) ?? null;
  const set: Record<string, unknown> = { shareEnabled: anyActive };
  if (def) set.shareId = def.shareId;
  await ProjectModel.updateOne({ _id: id }, { $set: set });
}

/** `link` is null when the plan refused the create; `limit.ok` is then false. */
export type CreateProjectLinkResult = { link: ShareLink | null; limit: LimitCheck };

/**
 * Create a link on a project. **Pro only.**
 *
 * This is the one link-create in the product a plan can refuse. Document links are deliberately
 * never plan-capped (the Free cap counts shared documents, and a document is meant to carry one
 * link per audience), but sending one project to several audiences is the data-room feature, and
 * PRD decision 7 makes it the Pro trigger. Free is refused here with the standard blocked
 * `LimitCheck`, which the route turns into a `402` and the client into the upgrade modal; the
 * project's default link, materialised above rather than created, keeps working untouched.
 */
export async function createProjectLink(input: {
  orgId: string | Types.ObjectId;
  projectId: string | Types.ObjectId;
  userId: string | Types.ObjectId | null;
  createdVia: "web" | "api" | "mcp";
  settings: ShareLinkSettingsInput & { label: string };
}): Promise<CreateProjectLinkResult> {
  await connectMongo();
  const orgId = oid(input.orgId);
  const projectId = oid(input.projectId);
  const project = await findProject({ orgId, projectId });
  if (!project) throw new ShareLinkError("not_found", "Project not found.");
  await ensureDefaultProjectLink(project);

  // Validate before the plan check so a Free caller sending a blank label still learns the label is
  // required, rather than being told to upgrade in order to be told the same thing afterwards.
  const label = validateLabel(input.settings.label);
  const audience = validateAudience(input.settings.audience);
  const expiresAt = validateExpiry(input.settings.expiresAt);
  const password = passwordFields(input.settings.password);

  const gate = await checkLimit(orgId, "project_links");
  if (!gate.ok) return { link: null, limit: gate };

  const count = await ShareLinkModel.countDocuments({ projectId, ...PROJECT_LINK_FILTER, archivedAt: null });
  if (count >= SHARE_LINKS_PER_PROJECT_MAX) {
    throw new ShareLinkError("too_many_links", `A project can have at most ${SHARE_LINKS_PER_PROJECT_MAX} links.`);
  }

  const enabled = input.settings.enabled !== false;
  let created: ShareLink | null = null;
  for (let i = 0; i < 5 && !created; i++) {
    try {
      const row = await ShareLinkModel.create({
        orgId,
        projectId,
        docId: null,
        kind: "project",
        shareId: newShareId(),
        label,
        audience,
        isDefault: false,
        enabled,
        allowDownload: Boolean(input.settings.allowDownload),
        allowRevisionHistory: false,
        expiresAt,
        ...password,
        createdByUserId: input.userId ? oid(input.userId) : null,
        createdVia: input.createdVia,
      });
      created = row.toObject() as ShareLink;
    } catch (e) {
      if (i === 4 || !/duplicate key/i.test(e instanceof Error ? e.message : String(e))) throw e;
    }
  }
  await syncProjectShareState(projectId);
  return { link: created as ShareLink, limit: gate };
}

/**
 * Patch a project link's settings.
 *
 * `PROJECT_LINK_FILTER` on the lookup is the tenancy guard that matters here: without it a caller
 * holding a *document* link's id could patch it through a project route, and
 * `syncProjectShareState` below would then run against a project the link does not belong to.
 * Re-enabling is not a plan decision — the gate is on creating a second link, and a link that
 * exists was already paid for.
 */
export async function updateProjectLink(input: {
  orgId: string | Types.ObjectId;
  linkId: string | Types.ObjectId;
  settings: ShareLinkSettingsInput;
  /** Internal: set by the project-level share switch so it can tell its own disables from the sender's. */
  viaProjectSwitch?: boolean;
}): Promise<{ link: ShareLink; restored?: ShareLink[] }> {
  await connectMongo();
  const link = await ShareLinkModel.findOne({
    _id: oid(input.linkId),
    orgId: oid(input.orgId),
    archivedAt: null,
    ...PROJECT_LINK_FILTER,
  }).lean<ShareLink>();
  if (!link) throw new ShareLinkError("not_found", "Link not found.");

  const set: Record<string, unknown> = {};
  const s = input.settings;
  if (s.label !== undefined) set.label = validateLabel(s.label);
  if (s.audience !== undefined) set.audience = validateAudience(s.audience);
  if (s.allowDownload !== undefined) set.allowDownload = Boolean(s.allowDownload);
  if (s.expiresAt !== undefined) set.expiresAt = validateExpiry(s.expiresAt);
  Object.assign(set, passwordFields(s.password));
  if (s.enabled !== undefined) {
    set.enabled = Boolean(s.enabled);
    // Same marker the document switch uses: switching the project back on re-enables only the
    // links the switch itself turned off, so a recipient whose link was revoked stays revoked.
    set.disabledByDocSwitch = !s.enabled && input.viaProjectSwitch === true;
  }
  if (Object.keys(set).length === 0) return { link };
  const updated = await ShareLinkModel.findOneAndUpdate({ _id: link._id }, { $set: set }, { new: true }).lean<ShareLink>();

  /**
   * Enabling one link republishes the page, so it has to restore what the page switch took down.
   *
   * `Project.shareEnabled` is derived — "this project has at least one active link"
   * (`syncProjectShareState`) — so enabling any single link turns the public page back on. There
   * were then two routes to a live page and only one of them put the other links back: the explicit
   * `PATCH /api/projects/:id { shareEnabled: true }` calls `setAllProjectLinksEnabled`, which
   * restores every link marked `disabledByDocSwitch`, while this path restored nothing.
   *
   * The result was a data room that came back up with most of its recipients still locked out,
   * silently and permanently: the links were disabled only because the page had been switched off,
   * the page was on again, and nothing would ever clear the marker. The owner saw a working room;
   * two of three recipients saw a dead link.
   *
   * Restoring only marked links is what keeps this safe. A link the sender revoked on its own is
   * not marked, so it stays revoked — the distinction the marker exists for.
   */
  const restored: ShareLink[] = [];
  if (set.enabled === true && !input.viaProjectSwitch) {
    const siblings = await ShareLinkModel.find({
      projectId: link.projectId,
      ...PROJECT_LINK_FILTER,
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

  await syncProjectShareState(link.projectId as Types.ObjectId);
  return { link: updated ?? link, ...(restored.length ? { restored } : {}) };
}

/**
 * Promote a link to be the project's default: the one the project page's side panel shows and the
 * one `Project.shareId` points at.
 *
 * The mirror of `setDefaultShareLink`. The previous default stays a perfectly good link (same URL,
 * same stats) and becomes deletable — which is the only way a project's original `/p/:shareId` can
 * ever be retired, so the links page needs it exactly as the document one does.
 */
export async function setDefaultProjectLink(input: {
  orgId: string | Types.ObjectId;
  projectId: string | Types.ObjectId;
  linkId: string | Types.ObjectId;
}): Promise<ShareLink> {
  await connectMongo();
  const orgId = oid(input.orgId);
  const projectId = oid(input.projectId);
  const next = await ShareLinkModel.findOne({
    _id: oid(input.linkId),
    orgId,
    projectId,
    archivedAt: null,
    ...PROJECT_LINK_FILTER,
  }).lean<ShareLink>();
  if (!next) throw new ShareLinkError("not_found", "Link not found.");
  if (next.isDefault) return next;
  // Scoped to this project, and explicitly to project links: an `{ isDefault: true }` filter that
  // ever lost its owner clause would clear the default on every link in the database, document
  // links included. `setDefaultShareLink` in links.ts carries the mirror-image comment.
  await ShareLinkModel.updateMany({ projectId, ...PROJECT_LINK_FILTER, isDefault: true }, { $set: { isDefault: false } });
  const updated = await ShareLinkModel.findOneAndUpdate({ _id: next._id }, { $set: { isDefault: true } }, { new: true }).lean<ShareLink>();
  // Moves `Project.shareId` onto the new default.
  await syncProjectShareState(projectId);
  return updated ?? next;
}

/**
 * Every live (unarchived) slug of a project, plus every slug its analytics rows still carry.
 *
 * The project analytics route needs both: the first is "which links can a person still open", the
 * second is the `$match` that makes a project's totals the sum over its links *including* the ones
 * that were deleted after the fact — the same promise the delete confirm makes for documents.
 */
export async function projectShareIds(input: {
  orgId: string | Types.ObjectId;
  projectId: string | Types.ObjectId;
}): Promise<{ live: string[]; all: string[] }> {
  await connectMongo();
  const projectId = oid(input.projectId);
  const rows = await ShareLinkModel.find({ projectId, ...PROJECT_LINK_FILTER })
    .select({ shareId: 1, archivedAt: 1 })
    .lean<Array<{ shareId: string; archivedAt?: Date | null }>>();
  const all = rows.map((r) => r.shareId).filter(Boolean);
  const live = rows.filter((r) => !r.archivedAt).map((r) => r.shareId).filter(Boolean);
  return { live, all };
}

/**
 * Soft-delete a project link: it stops resolving, its analytics stay attached to its `shareId`.
 * The default link refuses to be archived — disabling it is the intended action, and archiving it
 * would leave `/p/:shareId` pointing at nothing for every recipient who already has the URL.
 */
export async function archiveProjectLink(input: { orgId: string | Types.ObjectId; linkId: string | Types.ObjectId }): Promise<ShareLink> {
  await connectMongo();
  const link = await ShareLinkModel.findOne({
    _id: oid(input.linkId),
    orgId: oid(input.orgId),
    archivedAt: null,
    ...PROJECT_LINK_FILTER,
  }).lean<ShareLink>();
  if (!link) throw new ShareLinkError("not_found", "Link not found.");
  if (link.isDefault) throw new ShareLinkError("validation", "The default link cannot be deleted; disable it instead.");
  const updated = await ShareLinkModel.findOneAndUpdate({ _id: link._id }, { $set: { archivedAt: new Date(), enabled: false } }, { new: true }).lean<ShareLink>();
  await syncProjectShareState(link.projectId as Types.ObjectId);
  return updated ?? link;
}

/**
 * Enable or disable every link of a project at once — the project-level share switch that
 * `PATCH /api/projects/:id { shareEnabled }` has always been.
 *
 * Turning it off marks each link it disables; turning it back on re-enables only those, so a link
 * the sender revoked on its own stays revoked. Projects switched off before the marker existed have
 * no marked links and no enabled ones; for those the switch falls back to enabling every link,
 * which is what it always did. (Same fallback, same reasoning, as `setAllLinksEnabled`.)
 */
export async function setAllProjectLinksEnabled(input: {
  orgId: string | Types.ObjectId;
  projectId: string | Types.ObjectId;
  enabled: boolean;
}): Promise<{ changed: number }> {
  // A write path, so it materialises the default link itself: `listProjectLinks` no longer does,
  // and switching sharing on for a project that predates the link model has to have something to
  // switch on.
  const project = await findProject({ orgId: input.orgId, projectId: input.projectId });
  if (project) await ensureDefaultProjectLink(project);
  const links = await listProjectLinks({ orgId: input.orgId, projectId: input.projectId });
  /**
   * The same rule as the document switch, imported rather than re-derived.
   *
   * This carried its own copy — "no marked links and none enabled" decided per *project* — which is
   * the shape the document side was fixed for and this one was not: it cannot tell a pre-marker
   * project from one whose every link the owner deliberately revoked, so turning sharing back on
   * handed revoked recipients their original URL again. Two implementations of one rule, and only
   * one of them got the fix; now there is one.
   */
  const everyLinkDisabled = links.every((l) => !l.enabled);
  let changed = 0;
  for (const l of links) {
    if (Boolean(l.enabled) === input.enabled) continue;
    if (input.enabled && !switchMayRestore(l as unknown as Parameters<typeof switchMayRestore>[0], { everyLinkDisabled })) continue;
    await updateProjectLink({ orgId: input.orgId, linkId: l._id, settings: { enabled: input.enabled }, viaProjectSwitch: true });
    changed += 1;
  }
  return { changed };
}
