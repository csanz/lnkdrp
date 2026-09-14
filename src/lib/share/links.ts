/**
 * Share links service — the one place that creates, lists, updates, resolves and counts the
 * links of a document (docs/prds/lnkdrp-multi-links.md).
 *
 * Rules enforced here, so routes, the MCP and scripts cannot disagree:
 * - `resolveShareLink(shareId)` is the only way a public share route turns a slug into a
 *   document, and it materialises the default link for pre-model documents on first touch.
 * - The Free cap ("3 active share links") counts enabled, unexpired, unarchived links across the
 *   workspace; creating or enabling a link goes through `checkLimit("active_links")`.
 * - `Doc.shareEnabled` is kept equal to "the document has at least one enabled link", and the
 *   default link's settings are mirrored onto the legacy Doc fields for one release, so older
 *   readers and the rollback build keep working.
 */
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { ShareLinkModel, type ShareLink } from "@/lib/models/ShareLink";
import { newShareId } from "@/lib/crypto/randomBase62";
import { encryptSharePassword, hashSharePassword } from "@/lib/sharePassword";
import { checkLimit, type LimitCheck } from "@/lib/billing/planLimits";

export const SHARE_LINK_LABEL_MAX = 80;
export const SHARE_LINK_AUDIENCE_MAX = 120;
export const SHARE_LINKS_PER_DOC_MAX = 50;
export const SHARE_PASSWORD_MIN = 8;
export const SHARE_PASSWORD_MAX = 128;
export const DEFAULT_LINK_LABEL = "Default link";

export type ShareLinkDTO = {
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

function isExpired(link: Pick<ShareLink, "expiresAt">, now = Date.now()): boolean {
  return Boolean(link.expiresAt && link.expiresAt.getTime() <= now);
}

/** Enabled, not archived, not expired. */
export function isLinkActive(link: Pick<ShareLink, "enabled" | "archivedAt" | "expiresAt">, now = Date.now()): boolean {
  return Boolean(link.enabled) && !link.archivedAt && !isExpired(link, now);
}

export function toShareLinkDTO(link: ShareLink): ShareLinkDTO {
  const status: ShareLinkDTO["status"] = link.archivedAt ? "archived" : !link.enabled ? "disabled" : isExpired(link) ? "expired" : "active";
  return {
    id: String(link._id),
    docId: String(link.docId),
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
    lastViewedAt: link.lastViewedAt ? link.lastViewedAt.toISOString() : null,
    viewCount: link.viewCount ?? 0,
    downloadCount: link.downloadCount ?? 0,
  };
}

/**
 * Materialise the default link for a document that predates the model, copying its share
 * settings. Idempotent: the unique `shareId` index makes a concurrent double-create a no-op.
 */
export async function ensureDefaultLink(doc: DocLike): Promise<ShareLink> {
  await connectMongo();
  const existing = await ShareLinkModel.findOne({ docId: doc._id, isDefault: true }).lean<ShareLink>();
  if (existing) return existing;
  const shareId = (doc.shareId && String(doc.shareId).trim()) || newShareId();
  const byShareId = await ShareLinkModel.findOne({ shareId }).lean<ShareLink>();
  if (byShareId) return byShareId;
  try {
    const created = await ShareLinkModel.create({
      orgId: doc.orgId ?? undefined,
      docId: doc._id,
      shareId,
      label: DEFAULT_LINK_LABEL,
      audience: null,
      isDefault: true,
      enabled: doc.shareEnabled !== false,
      allowDownload: Boolean(doc.shareAllowPdfDownload),
      allowRevisionHistory: Boolean(doc.shareAllowRevisionHistory),
      expiresAt: null,
      passwordSalt: doc.sharePasswordSalt ?? null,
      passwordHash: doc.sharePasswordHash ?? null,
      passwordEnc: doc.sharePasswordEnc ?? null,
      passwordEncIv: doc.sharePasswordEncIv ?? null,
      passwordEncTag: doc.sharePasswordEncTag ?? null,
      createdByUserId: doc.userId ?? null,
      createdVia: "migration",
    });
    if (!doc.shareId) await DocModel.updateOne({ _id: doc._id }, { $set: { shareId } });
    return created.toObject() as ShareLink;
  } catch (e) {
    // Lost a race on the unique index: return whichever row won.
    const again = await ShareLinkModel.findOne({ $or: [{ shareId }, { docId: doc._id, isDefault: true }] }).lean<ShareLink>();
    if (again) return again;
    throw e;
  }
}

export type ResolvedShareLink = {
  link: ShareLink;
  doc: DocLike & Record<string, unknown>;
  /** Why a public route must refuse, or null when the link may be served. */
  refusal: null | "disabled" | "expired" | "archived" | "doc_gone";
};

/**
 * Turn a public slug into its link and document. Falls back to `Doc.shareId` for documents that
 * have no link row yet (and creates their default link). Returns null when nothing matches.
 * The caller decides what to do with `refusal` (share routes answer 404).
 */
export async function resolveShareLink(shareId: string, opts: { select?: Record<string, 1> } = {}): Promise<ResolvedShareLink | null> {
  const slug = (shareId || "").trim();
  if (!slug) return null;
  await connectMongo();
  let link = await ShareLinkModel.findOne({ shareId: slug }).lean<ShareLink>();
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
    link = await ensureDefaultLink(doc);
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
 * Enabled, unexpired, unarchived links across the workspace: the Free cap's unit.
 *
 * Default links are materialised lazily (`ensureDefaultLink`), so a workspace whose documents
 * predate this model would otherwise count zero and the cap would stop blocking. The second term
 * counts exactly those documents — shared, alive, and with no link row at all — which is the
 * legacy meaning of "active link". It goes to zero once `scripts/sharelinks-backfill.ts` has run,
 * and stays correct in the meantime (and for any document created while a deploy is half-rolled).
 */
export async function countActiveShareLinks(orgId: string | Types.ObjectId): Promise<number> {
  await connectMongo();
  const id = oid(orgId);
  const [fromLinks, legacyDocs] = await Promise.all([countActiveLinksOnLiveDocs(id), countSharedDocsWithoutLinks(id)]);
  return fromLinks + legacyDocs;
}

/**
 * Active links whose document is still alive and unarchived.
 *
 * The document check is what keeps the promise on `/pricing`: "archive a document any time to
 * free up a link slot". `resolveShareLink` already refuses a link on an archived document, so
 * counting it would charge a Free workspace for a link nobody can open.
 */
async function countActiveLinksOnLiveDocs(orgId: Types.ObjectId): Promise<number> {
  const rows = await ShareLinkModel.aggregate<{ n: number }>([
    {
      $match: {
        orgId,
        enabled: true,
        archivedAt: null,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
      },
    },
    { $project: { docId: 1 } },
    { $lookup: { from: "docs", localField: "docId", foreignField: "_id", as: "doc", pipeline: [{ $project: { isDeleted: 1, isArchived: 1 } }] } },
    { $unwind: "$doc" },
    { $match: { "doc.isDeleted": { $ne: true }, "doc.isArchived": { $ne: true } } },
    { $count: "n" },
  ]);
  return rows[0]?.n ?? 0;
}

/**
 * Documents that would be "one active link" under the pre-links model and have no link row yet.
 * One aggregation over the workspace's shared documents; the `$lookup` is on `sharelinks.docId`,
 * which is indexed.
 */
async function countSharedDocsWithoutLinks(orgId: Types.ObjectId): Promise<number> {
  const rows = await DocModel.aggregate<{ n: number }>([
    { $match: { orgId, shareEnabled: { $ne: false }, isDeleted: { $ne: true }, isArchived: { $ne: true } } },
    { $project: { _id: 1 } },
    { $lookup: { from: "sharelinks", localField: "_id", foreignField: "docId", as: "links" } },
    { $match: { links: { $size: 0 } } },
    { $count: "n" },
  ]);
  return rows[0]?.n ?? 0;
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

function validateLabel(label: unknown): string {
  const s = typeof label === "string" ? label.trim() : "";
  if (!s) throw new ShareLinkError("validation", "A label is required.");
  if (s.length > SHARE_LINK_LABEL_MAX) throw new ShareLinkError("validation", `Label must be ${SHARE_LINK_LABEL_MAX} characters or fewer.`);
  return s;
}

function validateAudience(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  if (s.length > SHARE_LINK_AUDIENCE_MAX) throw new ShareLinkError("validation", `Audience must be ${SHARE_LINK_AUDIENCE_MAX} characters or fewer.`);
  return s;
}

function validateExpiry(v: unknown): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new ShareLinkError("validation", "expiresAt must be an ISO date.");
  if (d.getTime() <= Date.now()) throw new ShareLinkError("validation", "expiresAt must be in the future.");
  return d;
}

function passwordFields(password: string | null | undefined): Record<string, unknown> {
  if (password === undefined) return {};
  if (password === null || password === "") {
    return { passwordSalt: null, passwordHash: null, passwordEnc: null, passwordEncIv: null, passwordEncTag: null };
  }
  const trimmed = password.trim();
  if (trimmed.length < SHARE_PASSWORD_MIN) throw new ShareLinkError("validation", `Password must be at least ${SHARE_PASSWORD_MIN} characters.`);
  if (trimmed.length > SHARE_PASSWORD_MAX) throw new ShareLinkError("validation", "Password is too long.");
  const { salt, hash } = hashSharePassword(trimmed);
  const enc = encryptSharePassword(trimmed);
  return { passwordSalt: salt, passwordHash: hash, passwordEnc: enc.enc, passwordEncIv: enc.iv, passwordEncTag: enc.tag };
}

/**
 * Keep the legacy Doc fields coherent: `shareEnabled` = any active link; the default link's
 * settings mirrored so readers that still look at the document (and a rollback build) agree.
 */
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

  const wantsEnabled = input.settings.enabled !== false;
  const limit = wantsEnabled ? await checkLimit(orgId, "active_links") : ({ ok: true, warning: null } as LimitCheck);
  const enabled = wantsEnabled && limit.ok;

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

export type UpdateShareLinkResult = { link: ShareLink; limit: LimitCheck | null };

/** Patch a link's settings. Enabling a disabled link re-checks the Free cap. */
export async function updateShareLink(input: {
  orgId: string | Types.ObjectId;
  linkId: string | Types.ObjectId;
  settings: ShareLinkSettingsInput;
}): Promise<UpdateShareLinkResult> {
  await connectMongo();
  const link = await ShareLinkModel.findOne({ _id: oid(input.linkId), orgId: oid(input.orgId), archivedAt: null }).lean<ShareLink>();
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
    if (s.enabled && !link.enabled) {
      limit = await checkLimit(link.orgId, "active_links");
      if (!limit.ok) return { link, limit };
    }
    set.enabled = Boolean(s.enabled);
  }
  if (Object.keys(set).length === 0) return { link, limit };
  const updated = await ShareLinkModel.findOneAndUpdate({ _id: link._id }, { $set: set }, { new: true }).lean<ShareLink>();
  await syncDocShareState(link.docId);
  return { link: updated ?? link, limit };
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
  const next = await ShareLinkModel.findOne({ _id: oid(input.linkId), orgId, docId, archivedAt: null }).lean<ShareLink>();
  if (!next) throw new ShareLinkError("not_found", "Link not found.");
  if (next.isDefault) return next;
  await ShareLinkModel.updateMany({ docId, isDefault: true }, { $set: { isDefault: false } });
  const updated = await ShareLinkModel.findOneAndUpdate({ _id: next._id }, { $set: { isDefault: true } }, { new: true }).lean<ShareLink>();
  // Moves `Doc.shareId` and mirrors the new default's settings onto the legacy document fields.
  await syncDocShareState(docId);
  return updated ?? next;
}

/** Soft-delete a link: it stops resolving; its analytics stay. The default link cannot be archived (disable it instead). */
export async function archiveShareLink(input: { orgId: string | Types.ObjectId; linkId: string | Types.ObjectId }): Promise<ShareLink> {
  await connectMongo();
  const link = await ShareLinkModel.findOne({ _id: oid(input.linkId), orgId: oid(input.orgId), archivedAt: null }).lean<ShareLink>();
  if (!link) throw new ShareLinkError("not_found", "Link not found.");
  if (link.isDefault) throw new ShareLinkError("validation", "The default link cannot be deleted; disable it instead.");
  const updated = await ShareLinkModel.findOneAndUpdate({ _id: link._id }, { $set: { archivedAt: new Date(), enabled: false } }, { new: true }).lean<ShareLink>();
  await syncDocShareState(link.docId);
  return updated ?? link;
}

/**
 * Enable or disable every link of a document at once (the document-level share switch).
 * Enabling goes through the cap for each link that was off; links that do not fit stay off.
 */
export async function setAllLinksEnabled(input: { orgId: string | Types.ObjectId; docId: string | Types.ObjectId; enabled: boolean }): Promise<{ changed: number; limit: LimitCheck | null }> {
  const links = await listShareLinks({ orgId: input.orgId, docId: input.docId });
  let changed = 0;
  let limit: LimitCheck | null = null;
  for (const l of links) {
    if (Boolean(l.enabled) === input.enabled) continue;
    const res = await updateShareLink({ orgId: input.orgId, linkId: l._id, settings: { enabled: input.enabled } });
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
