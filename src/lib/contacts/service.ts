/**
 * Contacts service: the one writer and every reader of `Contact` (docs/prds/lnkdrp-contacts.md).
 *
 * Routes stay thin on purpose. The rules that keep the table honest live here: the address is the
 * identity and is folded before it is looked up, a webmail domain never becomes a company, the
 * upsert is one write and never throws into the capture path that called it, and every read is
 * bounded by `orgId` so a contact can never be seen across workspaces.
 *
 * Identity follows the plan exactly as everywhere else (decision 4). Free sees, in full, the
 * contacts who introduced themselves, because introductions are already shown on Free; every
 * other contact is a row with a domain and dates and no name or address. The redaction is applied
 * here, once, to every DTO and to the CSV, so no surface can forget it.
 *
 * `verifiedAt` is not stored on the contact. `ShareViewerEmail` is the confirmation flow's own
 * record, keyed by the same `(orgId, email)`, and it is read from there at read time so the two
 * can never disagree.
 */
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { debugError } from "@/lib/debug";
import { getWorkspacePlan } from "@/lib/billing/planLimits";
import {
  CONTACT_DOC_IDS_KEPT,
  CONTACT_NOTE_MAX_CHARS,
  CONTACT_SOURCE_KINDS,
  CONTACT_SOURCES_KEPT,
  ContactModel,
  type ContactSourceKind,
} from "@/lib/models/Contact";
import { DocModel } from "@/lib/models/Doc";
import { ProjectModel } from "@/lib/models/Project";
import { ShareViewerEmailModel } from "@/lib/models/ShareViewerEmail";
import { TagAssignmentModel, type TagTargetKind } from "@/lib/models/TagAssignment";
import { UserModel } from "@/lib/models/User";
import { tagsForTarget, tagsForTargets, type TagDTO } from "@/lib/tags/service";
import { contactsToCsv } from "./csv";

export type { ContactSourceKind } from "@/lib/models/Contact";

/**
 * The tag target kind for a contact. Tags on contacts are the same `TagAssignment` rows as on a
 * document, with a third `targetKind` (decision 7).
 */
export const CONTACT_TAG_TARGET_KIND: TagTargetKind = "contact";

/**
 * Providers whose domain is where someone's mail lives, not who they work for.
 *
 * Matched on the first label of the domain, so `outlook.fr`, `yahoo.co.uk` and `hotmail.de` are
 * caught along with the `.com` each of them also runs. `gmail.com` sorting to the top of a domain
 * column as if it were a company with forty employees is exactly the wrong answer the column
 * exists to avoid.
 */
export const WEBMAIL_DOMAINS: readonly string[] = [
  "gmail",
  "googlemail",
  "outlook",
  "hotmail",
  "live",
  "yahoo",
  "icloud",
  "me",
  "mac",
  "proton",
  "protonmail",
  "pm",
  "aol",
  "gmx",
  "yandex",
  "mail",
  "msn",
  "zoho",
  "fastmail",
  "hey",
  "ymail",
];

/** The address's domain, or null for a webmail provider (or something that is not an address). */
export function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain) return null;
  const firstLabel = domain.split(".")[0] ?? "";
  if (WEBMAIL_DOMAINS.includes(firstLabel)) return null;
  return domain;
}

/** Lowercase, trimmed, plausibly an address; the same lenient rule the share viewer applies. */
function normalizeEmail(raw: string): string | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s || s.length > 254) return null;
  if (!s.includes("@") || s.startsWith("@") || s.endsWith("@")) return null;
  return s;
}

/** Collapse whitespace, trim, cap at 80: the viewer name rule. */
function normalizeName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > 80 ? s.slice(0, 80) : s;
}

function toObjectId(v: string | Types.ObjectId | null | undefined): Types.ObjectId | null {
  if (!v) return null;
  if (v instanceof Types.ObjectId) return v;
  const s = String(v).trim();
  return Types.ObjectId.isValid(s) ? new Types.ObjectId(s) : null;
}

/** A search string as a regex that matches it literally. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function iso(d: unknown): string {
  return d instanceof Date ? d.toISOString() : new Date(String(d)).toISOString();
}

export type UpsertContactInput = {
  orgId: string | Types.ObjectId;
  email: string;
  name?: string | null;
  source: ContactSourceKind;
  shareId?: string | null;
  docId?: string | Types.ObjectId | null;
  projectId?: string | Types.ObjectId | null;
  viewerUserId?: string | Types.ObjectId | null;
  at?: Date;
  /** A signed-in read or an introduction is a visit; a download request is not. */
  countsAsVisit?: boolean;
};

/**
 * Record that a workspace heard from an address. Idempotent, one write, never throws.
 *
 * Called from the capture sites off the hot path, so a failure here is logged and swallowed: a
 * view that was recorded must not become a view that was not because the contacts table was
 * unhappy. `$setOnInsert` keeps the first name and first sighting, `$set` moves the latest, the
 * sources ride a capped `$push`, and the document and project sets grow by `$addToSet`.
 */
export async function upsertContact(input: UpsertContactInput): Promise<void> {
  try {
    const orgId = toObjectId(input.orgId);
    const email = normalizeEmail(input.email);
    if (!orgId || !email) return;
    if (!CONTACT_SOURCE_KINDS.includes(input.source)) return;

    const at = input.at ?? new Date();
    const name = normalizeName(input.name);
    const docId = toObjectId(input.docId);
    const projectId = toObjectId(input.projectId);
    const viewerUserId = toObjectId(input.viewerUserId);
    const shareId = typeof input.shareId === "string" && input.shareId.trim() ? input.shareId.trim() : null;

    const set: Record<string, unknown> = { lastSeenAt: at, domain: domainOf(email) };
    if (name) set.name = name;
    if (viewerUserId) set.viewerUserId = viewerUserId;

    const setOnInsert: Record<string, unknown> = { orgId, email, firstSeenAt: at };
    if (name) setOnInsert.nameFirstGiven = name;

    const addToSet: Record<string, unknown> = {};
    if (docId) addToSet.docIds = docId;
    if (projectId) addToSet.projectIds = projectId;

    const update: Record<string, unknown> = {
      $setOnInsert: setOnInsert,
      $set: set,
      $push: {
        sources: {
          $each: [{ kind: input.source, shareId, docId, projectId, at }],
          $slice: -CONTACT_SOURCES_KEPT,
        },
      },
      ...(Object.keys(addToSet).length ? { $addToSet: addToSet } : {}),
      ...(input.countsAsVisit ? { $inc: { visits: 1 } } : {}),
    };

    await connectMongo();
    const row = (await ContactModel.findOneAndUpdate({ orgId, email }, update, {
      upsert: true,
      new: true,
      projection: { docIds: 1 },
    }).lean()) as { docIds?: unknown[] } | null;

    // `$addToSet` cannot trim. The cap is a ceiling against the BSON limit, not a figure anyone
    // reads, so it is enforced only when a row has actually crossed it.
    if (Array.isArray(row?.docIds) && row.docIds.length > CONTACT_DOC_IDS_KEPT) {
      await ContactModel.updateOne({ orgId, email }, { $push: { docIds: { $each: [], $slice: -CONTACT_DOC_IDS_KEPT } } });
    }
  } catch (e) {
    // Two captures for the same new address at once race the unique index; the loser's row exists.
    const message = e instanceof Error ? e.message : String(e);
    if (/E11000|duplicate key/i.test(message)) return;
    debugError(1, "[contacts] upsert failed", { source: input.source, message });
  }
}

export type ContactRow = {
  id: string;
  name: string | null;
  email: string | null;
  domain: string | null;
  verified: boolean;
  /** They introduced themselves at least once, which is what Free is allowed to see in full. */
  introduced: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  documentsRead: number;
  projectsCount: number;
  visits: number;
  tags: TagDTO[];
  lastSource: { kind: ContactSourceKind; at: string } | null;
};

export type ContactSourceDTO = {
  kind: ContactSourceKind;
  shareId: string | null;
  docId: string | null;
  projectId: string | null;
  at: string;
};

export type ContactDetail = ContactRow & {
  sources: ContactSourceDTO[];
  docs: Array<{ docId: string; title: string | null; shareId: string | null; lastSeenAt: string | null }>;
  projects: Array<{ projectId: string; name: string | null; slug: string | null }>;
  note: { text: string; byUserId: string | null; byName: string | null; at: string } | null;
};

export type ContactSort = "lastSeen" | "firstSeen" | "name" | "domain" | "documentsRead" | "visits";

export type ContactFilters = {
  q?: string;
  tagId?: string;
  docId?: string;
  projectId?: string;
  shareId?: string;
  domain?: string;
  source?: ContactSourceKind;
};

export const CONTACT_SORTS: readonly ContactSort[] = ["lastSeen", "firstSeen", "name", "domain", "documentsRead", "visits"];

/**
 * The highest page number a list will honour.
 *
 * `limit` was clamped at both ends and `page` only at the bottom, so `?page=1e21` reached Mongo as
 * `$skip: 5e22`, which is not a 64-bit integer: the aggregate threw and the route answered 500
 * where a bad query parameter deserves an empty page. A million pages of 200 keeps `$skip` under
 * 2e8, which is comfortably representable, and a stale bookmark past the end of a shrunken list
 * still renders as empty rather than as an error.
 */
const CONTACTS_MAX_PAGE = 1_000_000;

/** The stored row as the service reads it. Loose on purpose: `lean()` gives back what is there. */
type ContactDoc = {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  email: string;
  name?: string | null;
  nameFirstGiven?: string | null;
  domain?: string | null;
  viewerUserId?: Types.ObjectId | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  sources?: Array<{ kind: ContactSourceKind; shareId?: string | null; docId?: Types.ObjectId | null; projectId?: Types.ObjectId | null; at: Date }>;
  docIds?: Types.ObjectId[];
  projectIds?: Types.ObjectId[];
  visits?: number;
  note?: { text?: string; byUserId?: Types.ObjectId | null; at?: Date } | null;
};

/** Decision 4, applied once: without identity, a contact who never introduced themselves is a domain and dates. */
function redact<T extends { name: string | null; email: string | null; introduced: boolean }>(row: T, identity: boolean): T {
  if (identity || row.introduced) return row;
  return { ...row, name: null, email: null };
}

function toRow(doc: ContactDoc, params: { identity: boolean; verified: boolean; tags: TagDTO[] }): ContactRow {
  const sources = Array.isArray(doc.sources) ? doc.sources : [];
  const last = sources.length ? sources[sources.length - 1] : null;
  return redact(
    {
      id: String(doc._id),
      name: doc.name ?? null,
      email: doc.email ?? null,
      domain: doc.domain ?? null,
      verified: params.verified,
      introduced: sources.some((s) => s?.kind === "introduced"),
      firstSeenAt: iso(doc.firstSeenAt),
      lastSeenAt: iso(doc.lastSeenAt),
      documentsRead: Array.isArray(doc.docIds) ? doc.docIds.length : 0,
      projectsCount: Array.isArray(doc.projectIds) ? doc.projectIds.length : 0,
      visits: typeof doc.visits === "number" ? doc.visits : 0,
      tags: params.tags,
      lastSource: last ? { kind: last.kind, at: iso(last.at) } : null,
    },
    params.identity,
  );
}

/** Which addresses in this workspace have a confirmed click, from the confirmation flow's own table. */
async function verifiedEmails(orgId: Types.ObjectId, emails: string[]): Promise<Set<string>> {
  if (!emails.length) return new Set();
  const rows = (await ShareViewerEmailModel.find({ orgId, email: { $in: emails }, verifiedAt: { $ne: null } })
    .select({ email: 1 })
    .lean()) as Array<{ email?: string }>;
  return new Set(rows.map((r) => String(r.email ?? "").toLowerCase()).filter(Boolean));
}

/**
 * The Mongo filter for a list, or null when a filter can only match nothing (a malformed id, a tag
 * with no contacts), so the caller can answer empty without a query.
 */
async function buildFilter(orgId: Types.ObjectId, f: ContactFilters): Promise<Record<string, unknown> | null> {
  const filter: Record<string, unknown> = { orgId, isDeleted: { $ne: true } };

  const q = typeof f.q === "string" ? f.q.trim() : "";
  if (q) {
    const re = { $regex: escapeRegex(q.slice(0, 200)), $options: "i" };
    filter.$or = [{ name: re }, { email: re }, { domain: re }];
  }
  if (f.docId) {
    const id = toObjectId(f.docId);
    if (!id) return null;
    filter.docIds = id;
  }
  if (f.projectId) {
    const id = toObjectId(f.projectId);
    if (!id) return null;
    filter.projectIds = id;
  }
  if (typeof f.shareId === "string" && f.shareId.trim()) filter["sources.shareId"] = f.shareId.trim();
  if (typeof f.domain === "string" && f.domain.trim()) filter.domain = f.domain.trim().toLowerCase();
  if (f.source) {
    if (!CONTACT_SOURCE_KINDS.includes(f.source)) return null;
    filter["sources.kind"] = f.source;
  }
  if (f.tagId) {
    const tagId = toObjectId(f.tagId);
    if (!tagId) return null;
    const rows = (await TagAssignmentModel.find({ orgId, tagId, targetKind: CONTACT_TAG_TARGET_KIND })
      .select({ targetId: 1 })
      .lean()) as Array<{ targetId?: Types.ObjectId }>;
    const ids = rows.map((r) => r.targetId).filter((id): id is Types.ObjectId => Boolean(id));
    if (!ids.length) return null;
    filter._id = { $in: ids };
  }
  return filter;
}

/** The `$sort` stage for a sort key; `_id` breaks ties so pages never repeat or skip a row. */
function sortStage(sort: ContactSort, dir: "asc" | "desc"): Record<string, 1 | -1> {
  const d: 1 | -1 = dir === "asc" ? 1 : -1;
  const field: Record<ContactSort, string> = {
    lastSeen: "lastSeenAt",
    firstSeen: "firstSeenAt",
    name: "name",
    domain: "domain",
    documentsRead: "documentsRead",
    visits: "visits",
  };
  return { [field[sort]]: d, _id: d };
}

/** One page of matching rows, already joined to tags and verification, in list order. */
async function queryRows(params: {
  orgId: Types.ObjectId;
  identity: boolean;
  filter: Record<string, unknown>;
  sort: ContactSort;
  dir: "asc" | "desc";
  skip: number;
  limit: number;
}): Promise<ContactRow[]> {
  const docs = (await ContactModel.aggregate([
    { $match: params.filter },
    // `documentsRead` is the size of `docIds`; it exists only so the list can sort by it.
    { $addFields: { documentsRead: { $size: { $ifNull: ["$docIds", []] } } } },
    { $sort: sortStage(params.sort, params.dir) },
    { $skip: params.skip },
    { $limit: params.limit },
    { $project: { note: 0, documentsRead: 0 } },
  ]).collation({ locale: "en", strength: 2 })) as ContactDoc[];
  if (!docs.length) return [];

  const [verified, tags] = await Promise.all([
    verifiedEmails(
      params.orgId,
      docs.map((d) => d.email),
    ),
    tagsForTargets({ orgId: params.orgId, targetKind: CONTACT_TAG_TARGET_KIND, targetIds: docs.map((d) => d._id) }),
  ]);
  return docs.map((d) =>
    toRow(d, {
      identity: params.identity,
      verified: verified.has(String(d.email).toLowerCase()),
      tags: tags.get(String(d._id)) ?? [],
    }),
  );
}

function pageArgs(params: { sort?: ContactSort; dir?: "asc" | "desc"; page?: number; limit?: number }) {
  const sort: ContactSort = params.sort && CONTACT_SORTS.includes(params.sort) ? params.sort : "lastSeen";
  const dir: "asc" | "desc" = params.dir === "asc" || params.dir === "desc" ? params.dir : sort === "name" || sort === "domain" ? "asc" : "desc";
  const limit = Math.min(Math.max(Math.trunc(params.limit ?? 50) || 50, 1), 200);
  const page = Math.min(Math.max(Math.trunc(params.page ?? 1) || 1, 1), CONTACTS_MAX_PAGE);
  return { sort, dir, limit, page };
}

/**
 * The contacts list: filtered, sorted, paged, with tags and verification joined, redacted per plan.
 *
 * Search matches name, address and domain with an escaped, case-insensitive regex: a search box is
 * user input and `.` is a legal thing to type. Default order is last seen, newest first; name and
 * domain default to ascending because that is how a list of names reads.
 */
export async function listContacts(
  params: { orgId: string | Types.ObjectId; identity: boolean } & ContactFilters & {
      sort?: ContactSort;
      dir?: "asc" | "desc";
      page?: number;
      limit?: number;
    },
): Promise<{ items: ContactRow[]; total: number; page: number; limit: number }> {
  const { sort, dir, limit, page } = pageArgs(params);
  const orgId = toObjectId(params.orgId);
  if (!orgId) return { items: [], total: 0, page, limit };
  await connectMongo();

  const filter = await buildFilter(orgId, params);
  if (!filter) return { items: [], total: 0, page, limit };

  const [total, items] = await Promise.all([
    ContactModel.countDocuments(filter),
    queryRows({ orgId, identity: params.identity, filter, sort, dir, skip: (page - 1) * limit, limit }),
  ]);
  return { items, total, page, limit };
}

/** One contact with its history: sources, the documents and projects by title, the note by name. */
export async function getContact(params: {
  orgId: string | Types.ObjectId;
  contactId: string;
  identity: boolean;
}): Promise<ContactDetail | null> {
  const orgId = toObjectId(params.orgId);
  const contactId = toObjectId(params.contactId);
  if (!orgId || !contactId) return null;
  await connectMongo();

  const doc = (await ContactModel.findOne({ _id: contactId, orgId, isDeleted: { $ne: true } }).lean()) as ContactDoc | null;
  if (!doc) return null;

  const docIds = Array.isArray(doc.docIds) ? doc.docIds : [];
  const projectIds = Array.isArray(doc.projectIds) ? doc.projectIds : [];
  const noteBy = doc.note?.byUserId ?? null;

  const [verified, tags, docRows, projectRows, noteAuthor] = await Promise.all([
    verifiedEmails(orgId, [doc.email]),
    tagsForTarget({ orgId, targetKind: CONTACT_TAG_TARGET_KIND, targetId: doc._id }),
    docIds.length
      ? (DocModel.find({ _id: { $in: docIds }, orgId, isDeleted: { $ne: true } })
          .select({ title: 1, docName: 1 })
          .lean() as unknown as Promise<Array<{ _id: Types.ObjectId; title?: string | null; docName?: string | null }>>)
      : Promise.resolve([]),
    projectIds.length
      ? (ProjectModel.find({ _id: { $in: projectIds }, orgId, isDeleted: { $ne: true } })
          .select({ name: 1, slug: 1 })
          .lean() as unknown as Promise<Array<{ _id: Types.ObjectId; name?: string | null; slug?: string | null }>>)
      : Promise.resolve([]),
    noteBy
      ? (UserModel.findById(noteBy).select({ name: 1 }).lean() as unknown as Promise<{ name?: string | null } | null>)
      : Promise.resolve(null),
  ]);

  const row = toRow(doc, { identity: params.identity, verified: verified.has(doc.email.toLowerCase()), tags });
  const sources = (Array.isArray(doc.sources) ? doc.sources : []).map((s) => ({
    kind: s.kind,
    shareId: s.shareId ?? null,
    docId: s.docId ? String(s.docId) : null,
    projectId: s.projectId ? String(s.projectId) : null,
    at: iso(s.at),
  }));

  // The newest source per document tells the history which link they read it on, and when.
  const lastByDoc = new Map<string, ContactSourceDTO>();
  for (const s of sources) if (s.docId) lastByDoc.set(s.docId, s);
  const titles = new Map(docRows.map((d) => [String(d._id), d.title?.trim() || d.docName?.trim() || null]));
  const docs = docIds.map((id) => {
    const key = String(id);
    const last = lastByDoc.get(key) ?? null;
    return { docId: key, title: titles.get(key) ?? null, shareId: last?.shareId ?? null, lastSeenAt: last?.at ?? null };
  });
  const names = new Map(projectRows.map((p) => [String(p._id), { name: p.name ?? null, slug: p.slug ?? null }]));
  const projects = projectIds.map((id) => {
    const key = String(id);
    const p = names.get(key);
    return { projectId: key, name: p?.name ?? null, slug: p?.slug ?? null };
  });

  const note =
    doc.note && typeof doc.note.text === "string" && doc.note.text
      ? {
          text: doc.note.text,
          byUserId: noteBy ? String(noteBy) : null,
          byName: noteAuthor?.name?.trim() || null,
          at: iso(doc.note.at ?? doc.lastSeenAt),
        }
      : null;

  return { ...row, sources, docs, projects, note };
}

/** Write the team's note on a contact. An empty string clears it. Returns the contact, or null when it is not theirs. */
export async function setContactNote(params: {
  orgId: string | Types.ObjectId;
  contactId: string;
  userId: string | Types.ObjectId;
  text: string;
}): Promise<ContactDetail | null> {
  const orgId = toObjectId(params.orgId);
  const contactId = toObjectId(params.contactId);
  const userId = toObjectId(params.userId);
  if (!orgId || !contactId) return null;
  await connectMongo();

  const text = String(params.text ?? "")
    .trim()
    .slice(0, CONTACT_NOTE_MAX_CHARS);
  const note = text ? { text, byUserId: userId, at: new Date() } : null;
  const res = await ContactModel.updateOne({ _id: contactId, orgId, isDeleted: { $ne: true } }, { $set: { note } });
  if (!res.matchedCount) return null;

  const identity = await contactIdentityAllowed(orgId);
  return getContact({ orgId, contactId: params.contactId, identity });
}

/** How many rows a CSV may carry. A list past this is a database dump, not a spreadsheet. */
export const CONTACTS_CSV_MAX_ROWS = 10_000;

/** The list as a CSV, every matching row, in the same order and with the same redaction as the page. */
export async function contactsCsv(
  params: { orgId: string | Types.ObjectId; identity: boolean } & ContactFilters & { sort?: ContactSort; dir?: "asc" | "desc" },
): Promise<string> {
  const { sort, dir } = pageArgs(params);
  const orgId = toObjectId(params.orgId);
  if (!orgId) return contactsToCsv([]);
  await connectMongo();

  const filter = await buildFilter(orgId, params);
  if (!filter) return contactsToCsv([]);

  const rows: ContactRow[] = [];
  const pageSize = 200;
  for (let skip = 0; skip < CONTACTS_CSV_MAX_ROWS; skip += pageSize) {
    const batch = await queryRows({ orgId, identity: params.identity, filter, sort, dir, skip, limit: pageSize });
    rows.push(...batch);
    if (batch.length < pageSize) break;
  }
  return contactsToCsv(rows.slice(0, CONTACTS_CSV_MAX_ROWS));
}

/** Whether this workspace may see who its contacts are: Pro, exactly as every other identity surface. */
export async function contactIdentityAllowed(orgId: string | Types.ObjectId): Promise<boolean> {
  try {
    return (await getWorkspacePlan(orgId)) === "pro";
  } catch {
    return false;
  }
}
