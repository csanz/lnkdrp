/**
 * Contacts: the indexes, and the one-time backfill (docs/prds/lnkdrp-contacts.md decision 11).
 *
 * The capture sites only see people from the moment they ship. Everyone a workspace has already
 * heard from is on a `ShareView` or `ProjectLinkView` row (an introduction, or a signed-in read),
 * a `ShareDownloadRequest` (the address they typed to ask for a file) or a `ShareViewerEmail`
 * (the confirmation flow's own record of an introduction), so the table is built from those once
 * and the page is full on day one rather than starting from the next visitor.
 *
 * Same rules as `upsertContact` in src/lib/contacts/service.ts: the address is the identity,
 * folded; a webmail domain is not a company; owner-side rows are not contacts; a name-only reader
 * is not a contact. Written with `$min`/`$max` on the dates, `$addToSet` on the ids and on the
 * sources (whole-subdocument equality, so the same source twice is one), and `$setOnInsert` for
 * the names and the visit count, so a second run changes nothing and a contact that live traffic
 * created first keeps what it has.
 *
 * Indexes are declared in `Contact.ts` too, with the same keys and names, so autoIndex does not
 * conflict. The unique one goes first: a duplicate would mean two rows for one person, and it is
 * better to fail here than to build on that.
 *
 * `CONTACTS_BACKFILL_DRY_RUN=1` counts and prints without writing (the runner's own `--dry-run`
 * only lists files).
 */
import { ObjectId } from "mongodb";

const WEBMAIL = new Set([
  "gmail", "googlemail", "outlook", "hotmail", "live", "yahoo", "icloud", "me", "mac", "proton",
  "protonmail", "pm", "aol", "gmx", "yandex", "mail", "msn", "zoho", "fastmail", "hey", "ymail",
]);
const SOURCES_KEPT = 50;
const DOC_IDS_KEPT = 500;

function normalizeEmail(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s || s.length > 254) return null;
  if (!s.includes("@") || s.startsWith("@") || s.endsWith("@")) return null;
  return s;
}

function normalizeName(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > 80 ? s.slice(0, 80) : s;
}

function domainOf(email) {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1);
  if (!domain) return null;
  return WEBMAIL.has(domain.split(".")[0]) ? null : domain;
}

function asDate(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v;
  const d = v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

function oid(v) {
  if (!v) return null;
  if (v instanceof ObjectId) return v;
  return ObjectId.isValid(String(v)) ? new ObjectId(String(v)) : null;
}

async function ensureIndex(coll, key, options) {
  const indexes = await coll
    .indexes()
    .catch((e) => (e?.code === 26 || /ns does not exist/i.test(String(e?.message)) ? [] : Promise.reject(e)));
  const existing = indexes.find((i) => i?.name === options.name);
  if (existing) {
    if (JSON.stringify(existing.key ?? null) === JSON.stringify(key) && Boolean(existing.unique) === Boolean(options.unique)) return;
    await coll.dropIndex(options.name);
  }
  await coll.createIndex(key, options);
}

/**
 * The in-memory picture of one contact while a workspace is being walked. Sources are keyed so the
 * same (kind, link, document, instant) is one entry however many rows describe it.
 */
class Draft {
  constructor(orgId, email) {
    this.orgId = orgId;
    this.email = email;
    this.name = null;
    this.nameAt = null;
    this.nameFirstGiven = null;
    this.nameFirstAt = null;
    this.viewerUserId = null;
    this.firstSeenAt = null;
    this.lastSeenAt = null;
    this.sources = new Map();
    this.docIds = new Map();
    this.projectIds = new Map();
    this.visits = 0;
  }

  see(at) {
    if (!at) return;
    if (!this.firstSeenAt || at < this.firstSeenAt) this.firstSeenAt = at;
    if (!this.lastSeenAt || at > this.lastSeenAt) this.lastSeenAt = at;
  }

  named(name, at) {
    if (!name) return;
    const when = at ?? new Date(0);
    if (!this.nameAt || when >= this.nameAt) {
      this.name = name;
      this.nameAt = when;
    }
    if (!this.nameFirstAt || when < this.nameFirstAt) {
      this.nameFirstGiven = name;
      this.nameFirstAt = when;
    }
  }

  source(kind, { shareId = null, docId = null, projectId = null, at }) {
    if (!at) return;
    const key = `${kind}|${shareId ?? ""}|${docId ? String(docId) : ""}|${projectId ? String(projectId) : ""}|${at.getTime()}`;
    this.sources.set(key, { kind, shareId, docId, projectId, at });
    if (docId) this.docIds.set(String(docId), docId);
    if (projectId) this.projectIds.set(String(projectId), projectId);
    this.see(at);
  }

  toUpdate() {
    const sources = [...this.sources.values()].sort((a, b) => a.at - b.at).slice(-SOURCES_KEPT);
    const docIds = [...this.docIds.values()].slice(-DOC_IDS_KEPT);
    const projectIds = [...this.projectIds.values()];
    const setOnInsert = { orgId: this.orgId, email: this.email, visits: this.visits, isDeleted: false };
    if (this.name) setOnInsert.name = this.name;
    if (this.nameFirstGiven) setOnInsert.nameFirstGiven = this.nameFirstGiven;
    if (this.viewerUserId) setOnInsert.viewerUserId = this.viewerUserId;
    const now = new Date();
    return {
      $setOnInsert: { ...setOnInsert, createdDate: now },
      $set: { domain: domainOf(this.email), updatedDate: now },
      $min: { firstSeenAt: this.firstSeenAt ?? now },
      $max: { lastSeenAt: this.lastSeenAt ?? now },
      $addToSet: {
        ...(sources.length ? { sources: { $each: sources } } : {}),
        ...(docIds.length ? { docIds: { $each: docIds } } : {}),
        ...(projectIds.length ? { projectIds: { $each: projectIds } } : {}),
      },
    };
  }
}

export async function up({ db }) {
  const dryRun = process.env.CONTACTS_BACKFILL_DRY_RUN === "1";
  const contacts = db.collection("contacts");

  await ensureIndex(contacts, { orgId: 1, email: 1 }, { name: "orgId_1_email_1", unique: true });
  await ensureIndex(contacts, { orgId: 1, lastSeenAt: -1 }, { name: "orgId_1_lastSeenAt_-1" });
  await ensureIndex(contacts, { orgId: 1, domain: 1 }, { name: "orgId_1_domain_1" });
  await ensureIndex(contacts, { orgId: 1, docIds: 1 }, { name: "orgId_1_docIds_1" });
  await ensureIndex(contacts, { orgId: 1, projectIds: 1 }, { name: "orgId_1_projectIds_1" });
  await ensureIndex(contacts, { orgId: 1, name: 1 }, { name: "orgId_1_name_1" });

  const shareviews = db.collection("shareviews");
  const projectlinkviews = db.collection("projectlinkviews");
  const downloadRequests = db.collection("sharedownloadrequests");
  const viewerEmails = db.collection("sharevieweremails");
  const sharelinks = db.collection("sharelinks");
  const docs = db.collection("docs");
  const users = db.collection("users");
  const orgs = db.collection("orgs");

  // Every workspace that could have heard from anyone: the union of the org ids on the four
  // sources, plus the owner's personal org for legacy download requests and views without one.
  const orgIds = new Map();
  const noteOrg = (v) => {
    const id = oid(v);
    if (id) orgIds.set(String(id), id);
  };
  for (const coll of [shareviews, projectlinkviews, viewerEmails]) {
    for (const id of await coll.distinct("orgId", { orgId: { $type: "objectId" } })) noteOrg(id);
  }

  // Legacy rows: `ShareDownloadRequest` has no org and a pre-workspace `ShareView` has none, so
  // both resolve through the document (its `orgId`, else its owner's personal org).
  const docOrgCache = new Map();
  const userOrgCache = new Map();
  async function personalOrgOf(userId) {
    const key = String(userId);
    if (userOrgCache.has(key)) return userOrgCache.get(key);
    const org = await orgs.findOne({ type: "personal", personalForUserId: oid(userId), isDeleted: { $ne: true } }, { projection: { _id: 1 } });
    const id = org?._id ?? null;
    userOrgCache.set(key, id);
    return id;
  }
  async function orgOfDoc(docId) {
    const key = String(docId);
    if (docOrgCache.has(key)) return docOrgCache.get(key);
    const doc = await docs.findOne({ _id: oid(docId) }, { projection: { orgId: 1, userId: 1 } });
    let id = oid(doc?.orgId);
    if (!id && doc?.userId) id = await personalOrgOf(doc.userId);
    docOrgCache.set(key, id);
    return id;
  }
  for (const docId of await downloadRequests.distinct("docId")) {
    const id = await orgOfDoc(docId);
    if (id) noteOrg(id);
  }

  // Which link is a project link, so a document read inside a data room carries the project too.
  const linkProject = new Map();
  for await (const link of sharelinks.find({ kind: "project", projectId: { $type: "objectId" } }, { projection: { shareId: 1, projectId: 1 } })) {
    if (link.shareId) linkProject.set(String(link.shareId), link.projectId);
  }

  const userCache = new Map();
  async function userIdentity(userId) {
    const key = String(userId);
    if (userCache.has(key)) return userCache.get(key);
    const u = await users.findOne({ _id: oid(userId) }, { projection: { email: 1, name: 1 } });
    const out = u ? { email: normalizeEmail(u.email), name: normalizeName(u.name) } : null;
    userCache.set(key, out);
    return out;
  }

  const totals = { orgs: 0, rows: 0, contacts: 0, inserted: 0, updated: 0, skipped: 0 };

  for (const orgId of orgIds.values()) {
    totals.orgs += 1;
    const drafts = new Map();
    const draft = (email) => {
      let d = drafts.get(email);
      if (!d) {
        d = new Draft(orgId, email);
        drafts.set(email, d);
      }
      return d;
    };

    /** A `ShareView` or `ProjectLinkView` row, which carry identity field for field. */
    async function fromView(row, { docId, projectId }) {
      totals.rows += 1;
      if (row.isOwnerPreview === true) return;
      const at = asDate(row.lastViewedAt) ?? asDate(row.updatedDate) ?? asDate(row.createdDate);
      const first = asDate(row.createdDate) ?? at;
      const signedIn = Boolean(row.viewerUserId);
      let email = normalizeEmail(row.viewerEmailSnapshot) ?? normalizeEmail(row.viewerEmail);
      let name = normalizeName(row.viewerName);
      let viewerUserId = null;
      if (signedIn) {
        const u = await userIdentity(row.viewerUserId);
        if (u?.email) email = u.email;
        if (u?.name) name = u.name;
        viewerUserId = oid(row.viewerUserId);
      }
      if (!email) {
        totals.skipped += 1;
        return;
      }
      const d = draft(email);
      d.named(name, first);
      if (viewerUserId) d.viewerUserId = viewerUserId;
      d.source(signedIn ? "signed_in" : "introduced", { shareId: row.shareId ?? null, docId, projectId, at: first });
      d.see(at);
      d.visits += 1;
    }

    for await (const row of shareviews.find({ orgId }, { projection: { shareId: 1, docId: 1, viewerUserId: 1, viewerEmail: 1, viewerEmailSnapshot: 1, viewerName: 1, isOwnerPreview: 1, lastViewedAt: 1, createdDate: 1, updatedDate: 1 } })) {
      if (!row.viewerUserId && !row.viewerEmailSnapshot && !row.viewerEmail) continue;
      await fromView(row, { docId: oid(row.docId), projectId: linkProject.get(String(row.shareId)) ?? null });
    }
    for await (const row of projectlinkviews.find({ orgId }, { projection: { shareId: 1, projectId: 1, viewerUserId: 1, viewerEmail: 1, viewerEmailSnapshot: 1, viewerName: 1, isOwnerPreview: 1, lastViewedAt: 1, createdDate: 1, updatedDate: 1 } })) {
      if (!row.viewerUserId && !row.viewerEmailSnapshot && !row.viewerEmail) continue;
      await fromView(row, { docId: null, projectId: oid(row.projectId) });
    }

    for await (const row of downloadRequests.find({}, { projection: { shareId: 1, docId: 1, requesterEmail: 1, createdDate: 1 } })) {
      const rowOrg = await orgOfDoc(row.docId);
      if (!rowOrg || String(rowOrg) !== String(orgId)) continue;
      totals.rows += 1;
      const email = normalizeEmail(row.requesterEmail);
      const at = asDate(row.createdDate);
      if (!email || !at) {
        totals.skipped += 1;
        continue;
      }
      draft(email).source("download_request", { shareId: row.shareId ?? null, docId: oid(row.docId), projectId: linkProject.get(String(row.shareId)) ?? null, at });
    }

    for await (const row of viewerEmails.find({ orgId }, { projection: { email: 1, firstIntroducedAt: 1, shareId: 1, createdDate: 1 } })) {
      totals.rows += 1;
      const email = normalizeEmail(row.email);
      const at = asDate(row.firstIntroducedAt) ?? asDate(row.createdDate);
      if (!email || !at) {
        totals.skipped += 1;
        continue;
      }
      const d = draft(email);
      // The confirmation record knows the first link they introduced themselves on, and only
      // that; if a view row already told us about that introduction this adds nothing new.
      const already = [...d.sources.values()].some((s) => s.kind === "introduced");
      if (!already) d.source("introduced", { shareId: row.shareId ?? null, at });
      else d.see(at);
    }

    totals.contacts += drafts.size;
    if (dryRun) continue;
    for (const d of drafts.values()) {
      const res = await contacts.updateOne({ orgId, email: d.email }, d.toUpdate(), { upsert: true });
      if (res.upsertedCount) totals.inserted += 1;
      else if (res.modifiedCount) totals.updated += 1;
    }
  }

  console.log(
    `  contacts backfill${dryRun ? " (dry run, nothing written)" : ""}: ` +
      `${totals.orgs} workspace(s), ${totals.rows} source row(s), ${totals.contacts} contact(s), ` +
      `${totals.inserted} inserted, ${totals.updated} updated, ${totals.skipped} skipped (no address)`,
  );
}
