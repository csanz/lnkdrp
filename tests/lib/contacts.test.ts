/**
 * Contacts data layer (docs/prds/lnkdrp-contacts.md, decisions locked 2026-09-25).
 *
 * What is pinned here, without a database:
 * - `domainOf`: a webmail provider is where mail lives, not who someone works for (decision 3).
 * - `upsertContact` builds exactly one idempotent write: first name and first sighting on insert,
 *   latest on every call, sources capped, ids as sets, a visit only when the capture was a read,
 *   and it never throws into the capture path that called it.
 * - Redaction (decision 4): without identity, a contact who never introduced themselves is a
 *   domain and dates, in the list and in the CSV; an introduced one is shown in full on Free.
 * - `listContacts` query building: escaped search, filters that can only match nothing answer
 *   empty without a query, sort keys with an `_id` tie-break, clamped paging.
 * - CSV: RFC 4180 quoting and the fixed header.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const state = vi.hoisted(() => ({
  plan: "free" as "free" | "pro",
  aggregateDocs: [] as unknown[],
  total: 0,
  contact: null as unknown,
  verifiedRows: [] as Array<{ email: string }>,
  tagAssignmentRows: [] as Array<{ targetId: Types.ObjectId }>,
  docRows: [] as unknown[],
  projectRows: [] as unknown[],
  user: null as unknown,
  tagsByTarget: new Map<string, unknown[]>(),
  upsertResult: null as unknown,
  upsertError: null as Error | null,
  matchedCount: 1,
}));

const connectMongo = vi.fn(async () => undefined);
const debugError = vi.fn();
const findOneAndUpdate = vi.fn(() => {
  if (state.upsertError) return { lean: async () => Promise.reject(state.upsertError) };
  return { lean: async () => state.upsertResult };
});
const updateOne = vi.fn(async () => ({ matchedCount: state.matchedCount, modifiedCount: 1 }));
const aggregate = vi.fn((_pipeline: Array<Record<string, unknown>>) => ({ collation: async () => state.aggregateDocs }));
const countDocuments = vi.fn(async () => state.total);
const findOne = vi.fn(() => ({ lean: async () => state.contact }));
const shareViewerEmailFind = vi.fn(() => ({ select: () => ({ lean: async () => state.verifiedRows }) }));
const tagAssignmentFind = vi.fn(() => ({ select: () => ({ lean: async () => state.tagAssignmentRows }) }));
const tagsForTargets = vi.fn(async () => state.tagsByTarget);
const tagsForTarget = vi.fn(async () => []);

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/debug", () => ({ debugError, debugLog: vi.fn(), debugWarn: vi.fn(), debugEnabled: () => false }));
vi.mock("@/lib/billing/planLimits", () => ({ getWorkspacePlan: async () => state.plan }));
vi.mock("@/lib/models/Contact", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/models/Contact")>()),
  ContactModel: { findOneAndUpdate, updateOne, aggregate, countDocuments, findOne },
}));
vi.mock("@/lib/models/ShareViewerEmail", () => ({ ShareViewerEmailModel: { find: shareViewerEmailFind } }));
vi.mock("@/lib/models/TagAssignment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/models/TagAssignment")>()),
  TagAssignmentModel: { find: tagAssignmentFind },
}));
vi.mock("@/lib/models/Doc", () => ({
  DocModel: { find: () => ({ select: () => ({ lean: async () => state.docRows }) }) },
}));
vi.mock("@/lib/models/Project", () => ({
  ProjectModel: { find: () => ({ select: () => ({ lean: async () => state.projectRows }) }) },
}));
vi.mock("@/lib/models/User", () => ({
  UserModel: { findById: () => ({ select: () => ({ lean: async () => state.user }) }) },
}));
vi.mock("@/lib/tags/service", () => ({ tagsForTargets, tagsForTarget }));

const {
  WEBMAIL_DOMAINS,
  domainOf,
  upsertContact,
  listContacts,
  getContact,
  setContactNote,
  contactsCsv,
  contactIdentityAllowed,
  CONTACT_TAG_TARGET_KIND,
} = await import("@/lib/contacts/service");
const { csvField, contactsToCsv, CONTACTS_CSV_COLUMNS } = await import("@/lib/contacts/csv");
const { CONTACT_SOURCES_KEPT, CONTACT_DOC_IDS_KEPT } = await import("@/lib/models/Contact");
const { TAG_TARGET_KINDS } = await import("@/lib/models/TagAssignment");

const ORG = new Types.ObjectId();
const USER = new Types.ObjectId();
const DOC = new Types.ObjectId();
const PROJECT = new Types.ObjectId();
const T0 = new Date("2026-09-20T10:00:00.000Z");
const T1 = new Date("2026-09-25T10:00:00.000Z");

/** A stored contact row as `lean()` returns it. */
function contactDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(),
    orgId: ORG,
    email: "priya@sequoiacap.com",
    name: "Priya Nair",
    nameFirstGiven: "Priya",
    domain: "sequoiacap.com",
    viewerUserId: null,
    firstSeenAt: T0,
    lastSeenAt: T1,
    sources: [{ kind: "introduced", shareId: "abc123", docId: DOC, projectId: null, at: T0 }],
    docIds: [DOC],
    projectIds: [],
    visits: 3,
    note: null,
    ...overrides,
  };
}

type UpdateShape = Record<string, Record<string, unknown>>;

function lastUpsert(): { filter: Record<string, unknown>; update: UpdateShape; options: Record<string, unknown> } {
  const call = findOneAndUpdate.mock.calls.at(-1) as unknown as [Record<string, unknown>, UpdateShape, Record<string, unknown>];
  return { filter: call[0], update: call[1], options: call[2] };
}

beforeEach(() => {
  state.plan = "free";
  state.aggregateDocs = [];
  state.total = 0;
  state.contact = null;
  state.verifiedRows = [];
  state.tagAssignmentRows = [];
  state.docRows = [];
  state.projectRows = [];
  state.user = null;
  state.tagsByTarget = new Map();
  state.upsertResult = { docIds: [] };
  state.upsertError = null;
  state.matchedCount = 1;
  vi.clearAllMocks();
});

describe("domainOf", () => {
  test("a company address keeps its domain, folded", () => {
    expect(domainOf("Priya@SequoiaCap.com")).toBe("sequoiacap.com");
    expect(domainOf("a@b.co.uk")).toBe("b.co.uk");
  });

  test("webmail providers are null, whatever the country suffix", () => {
    for (const provider of WEBMAIL_DOMAINS) expect(domainOf(`x@${provider}.com`)).toBeNull();
    expect(domainOf("x@yahoo.co.uk")).toBeNull();
    expect(domainOf("x@outlook.fr")).toBeNull();
    expect(domainOf("x@hotmail.de")).toBeNull();
    expect(domainOf("x@me.com")).toBeNull();
  });

  test("a company that merely starts with a provider name is still a company", () => {
    expect(domainOf("x@gmailcorp.io")).toBe("gmailcorp.io");
    expect(domainOf("x@mail.sequoiacap.com")).toBeNull();
  });

  test("not an address is null", () => {
    expect(domainOf("nope")).toBeNull();
    expect(domainOf("trailing@")).toBeNull();
  });
});

describe("upsertContact builds one idempotent write", () => {
  test("an introduction: first name and first sighting on insert, latest on set, a visit, a capped source", async () => {
    await upsertContact({
      orgId: String(ORG),
      email: "  Priya@SequoiaCap.com ",
      name: "  Priya   Nair ",
      source: "introduced",
      shareId: "abc123",
      docId: String(DOC),
      projectId: PROJECT,
      at: T1,
      countsAsVisit: true,
    });

    expect(connectMongo).toHaveBeenCalled();
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    const { filter, update, options } = lastUpsert();
    expect(filter).toEqual({ orgId: ORG, email: "priya@sequoiacap.com" });
    expect(options).toMatchObject({ upsert: true, new: true });

    expect(update.$setOnInsert).toEqual({ orgId: ORG, email: "priya@sequoiacap.com", firstSeenAt: T1, nameFirstGiven: "Priya Nair" });
    expect(update.$set).toEqual({ lastSeenAt: T1, domain: "sequoiacap.com", name: "Priya Nair" });
    expect(update.$addToSet).toEqual({ docIds: DOC, projectIds: PROJECT });
    expect(update.$inc).toEqual({ visits: 1 });
    expect(update.$push).toEqual({
      sources: {
        $each: [{ kind: "introduced", shareId: "abc123", docId: DOC, projectId: PROJECT, at: T1 }],
        $slice: -CONTACT_SOURCES_KEPT,
      },
    });
    expect(CONTACT_SOURCES_KEPT).toBe(50);
  });

  test("a download request: no name, no visit, no project, domain still set", async () => {
    await upsertContact({ orgId: ORG, email: "someone@gmail.com", source: "download_request", shareId: "s1", docId: DOC, at: T1 });
    const { update } = lastUpsert();
    expect(update.$setOnInsert).toEqual({ orgId: ORG, email: "someone@gmail.com", firstSeenAt: T1 });
    expect(update.$set).toEqual({ lastSeenAt: T1, domain: null });
    expect(update.$inc).toBeUndefined();
    expect(update.$addToSet).toEqual({ docIds: DOC });
    expect((update.$push.sources as { $each: Array<Record<string, unknown>> }).$each[0]).toMatchObject({
      kind: "download_request",
      projectId: null,
    });
  });

  test("a signed-in read carries the account id", async () => {
    await upsertContact({ orgId: ORG, email: "me@acme.com", name: "Me", source: "signed_in", viewerUserId: String(USER), at: T1, countsAsVisit: true });
    const { update } = lastUpsert();
    expect(update.$set).toEqual({ lastSeenAt: T1, domain: "acme.com", name: "Me", viewerUserId: USER });
    expect(update.$addToSet).toBeUndefined();
  });

  test("no address, a malformed org or an unknown source: nothing is written", async () => {
    await upsertContact({ orgId: ORG, email: "not-an-address", source: "introduced" });
    await upsertContact({ orgId: "nope", email: "a@b.com", source: "introduced" });
    await upsertContact({ orgId: ORG, email: "a@b.com", source: "visit" as never });
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  test("never throws: a failing write is logged and swallowed", async () => {
    state.upsertError = new Error("boom");
    await expect(upsertContact({ orgId: ORG, email: "a@b.com", source: "introduced" })).resolves.toBeUndefined();
    expect(debugError).toHaveBeenCalledWith(1, "[contacts] upsert failed", expect.objectContaining({ source: "introduced", message: "boom" }));
  });

  test("a duplicate-key race is not even logged: the other writer's row exists", async () => {
    state.upsertError = new Error("E11000 duplicate key error collection: contacts");
    await upsertContact({ orgId: ORG, email: "a@b.com", source: "introduced" });
    expect(debugError).not.toHaveBeenCalled();
  });

  test("the document set is trimmed only once it crosses the cap", async () => {
    state.upsertResult = { docIds: new Array(CONTACT_DOC_IDS_KEPT + 1).fill(DOC) };
    await upsertContact({ orgId: ORG, email: "a@b.com", source: "signed_in", docId: DOC });
    expect(updateOne).toHaveBeenCalledWith(
      { orgId: ORG, email: "a@b.com" },
      { $push: { docIds: { $each: [], $slice: -CONTACT_DOC_IDS_KEPT } } },
    );

    updateOne.mockClear();
    state.upsertResult = { docIds: [DOC] };
    await upsertContact({ orgId: ORG, email: "a@b.com", source: "signed_in", docId: DOC });
    expect(updateOne).not.toHaveBeenCalled();
  });
});

describe("listContacts", () => {
  test("redaction: on Free an introduced contact is shown in full, a signed-in one is a domain and dates", async () => {
    const introduced = contactDoc();
    const signedIn = contactDoc({
      email: "dev@acme.com",
      name: "Dev Patel",
      domain: "acme.com",
      sources: [{ kind: "signed_in", shareId: "s2", docId: DOC, projectId: null, at: T1 }],
    });
    state.aggregateDocs = [introduced, signedIn];
    state.total = 2;
    state.verifiedRows = [{ email: "priya@sequoiacap.com" }];
    state.tagsByTarget = new Map([[String(introduced._id), [{ id: "t1", name: "investor", slug: "investor", color: "sky" }]]]);

    const free = await listContacts({ orgId: ORG, identity: false });
    expect(free.total).toBe(2);
    expect(free.items[0]).toMatchObject({
      id: String(introduced._id),
      name: "Priya Nair",
      email: "priya@sequoiacap.com",
      domain: "sequoiacap.com",
      verified: true,
      introduced: true,
      documentsRead: 1,
      projectsCount: 0,
      visits: 3,
      lastSource: { kind: "introduced", at: T0.toISOString() },
    });
    expect(free.items[0].tags).toEqual([{ id: "t1", name: "investor", slug: "investor", color: "sky" }]);
    expect(free.items[1]).toMatchObject({ name: null, email: null, domain: "acme.com", verified: false, introduced: false });
    expect(JSON.stringify(free.items[1])).not.toContain("Dev Patel");
    expect(JSON.stringify(free.items[1])).not.toContain("dev@acme.com");

    const pro = await listContacts({ orgId: ORG, identity: true });
    expect(pro.items[1]).toMatchObject({ name: "Dev Patel", email: "dev@acme.com" });

    expect(tagsForTargets).toHaveBeenCalledWith(expect.objectContaining({ targetKind: "contact" }));
    expect(TAG_TARGET_KINDS).toContain(CONTACT_TAG_TARGET_KIND);
  });

  test("default order is last seen, newest first, with an _id tie-break; the match is bounded by org and live rows", async () => {
    await listContacts({ orgId: ORG, identity: true });
    const pipeline = aggregate.mock.calls[0][0] as unknown as Array<Record<string, unknown>>;
    expect(pipeline[0]).toEqual({ $match: { orgId: ORG, isDeleted: { $ne: true } } });
    expect(pipeline.find((s) => "$sort" in s)).toEqual({ $sort: { lastSeenAt: -1, _id: -1 } });
    expect(pipeline.find((s) => "$skip" in s)).toEqual({ $skip: 0 });
    expect(pipeline.find((s) => "$limit" in s)).toEqual({ $limit: 50 });
    expect(countDocuments).toHaveBeenCalledWith({ orgId: ORG, isDeleted: { $ne: true } });
  });

  test("search is an escaped, case-insensitive regex over name, address and domain", async () => {
    await listContacts({ orgId: ORG, identity: true, q: " a.b+c " });
    const match = (aggregate.mock.calls[0][0] as unknown as Array<Record<string, unknown>>)[0].$match as Record<string, unknown>;
    const re = { $regex: String.raw`a\.b\+c`, $options: "i" };
    expect(match.$or).toEqual([{ name: re }, { email: re }, { domain: re }]);
  });

  test("filters land on the indexed fields", async () => {
    await listContacts({ orgId: ORG, identity: true, docId: String(DOC), projectId: String(PROJECT), shareId: "abc", domain: "Acme.COM", source: "signed_in" });
    const match = (aggregate.mock.calls[0][0] as unknown as Array<Record<string, unknown>>)[0].$match as Record<string, unknown>;
    expect(match).toEqual({
      orgId: ORG,
      isDeleted: { $ne: true },
      docIds: DOC,
      projectIds: PROJECT,
      "sources.shareId": "abc",
      domain: "acme.com",
      "sources.kind": "signed_in",
    });
  });

  test("a tag filter resolves through assignments; a tag with no contacts answers empty without a query", async () => {
    const tagId = new Types.ObjectId();
    const target = new Types.ObjectId();
    state.tagAssignmentRows = [{ targetId: target }];
    await listContacts({ orgId: ORG, identity: true, tagId: String(tagId) });
    expect(tagAssignmentFind).toHaveBeenCalledWith({ orgId: ORG, tagId, targetKind: "contact" });
    const match = (aggregate.mock.calls[0][0] as unknown as Array<Record<string, unknown>>)[0].$match as Record<string, unknown>;
    expect(match._id).toEqual({ $in: [target] });

    aggregate.mockClear();
    state.tagAssignmentRows = [];
    const empty = await listContacts({ orgId: ORG, identity: true, tagId: String(tagId) });
    expect(empty).toEqual({ items: [], total: 0, page: 1, limit: 50 });
    expect(aggregate).not.toHaveBeenCalled();
  });

  test("a malformed id filter answers empty without a query", async () => {
    const res = await listContacts({ orgId: ORG, identity: true, docId: "not-an-id" });
    expect(res.items).toEqual([]);
    expect(aggregate).not.toHaveBeenCalled();
  });

  test("sort keys, direction defaults and paging clamps", async () => {
    const sortOf = () => (aggregate.mock.calls.at(-1)![0] as unknown as Array<Record<string, unknown>>).find((s) => "$sort" in s)!.$sort;
    const stageOf = (key: string) => (aggregate.mock.calls.at(-1)![0] as unknown as Array<Record<string, unknown>>).find((s) => key in s)![key];

    await listContacts({ orgId: ORG, identity: true, sort: "name" });
    expect(sortOf()).toEqual({ name: 1, _id: 1 });
    await listContacts({ orgId: ORG, identity: true, sort: "domain", dir: "desc" });
    expect(sortOf()).toEqual({ domain: -1, _id: -1 });
    await listContacts({ orgId: ORG, identity: true, sort: "documentsRead" });
    expect(sortOf()).toEqual({ documentsRead: -1, _id: -1 });
    await listContacts({ orgId: ORG, identity: true, sort: "visits", dir: "asc" });
    expect(sortOf()).toEqual({ visits: 1, _id: 1 });
    await listContacts({ orgId: ORG, identity: true, sort: "firstSeen" });
    expect(sortOf()).toEqual({ firstSeenAt: -1, _id: -1 });
    await listContacts({ orgId: ORG, identity: true, sort: "bogus" as never });
    expect(sortOf()).toEqual({ lastSeenAt: -1, _id: -1 });

    const page = await listContacts({ orgId: ORG, identity: true, page: 3, limit: 999 });
    expect(page).toMatchObject({ page: 3, limit: 200 });
    expect(stageOf("$skip")).toBe(400);
    expect(stageOf("$limit")).toBe(200);

    const floor = await listContacts({ orgId: ORG, identity: true, page: -4, limit: 0 });
    expect(floor).toMatchObject({ page: 1, limit: 50 });
  });
});

describe("getContact and the note", () => {
  test("resolves documents and projects by title and the note author by name; redacts on Free", async () => {
    const doc = contactDoc({
      projectIds: [PROJECT],
      sources: [
        { kind: "signed_in", shareId: "s1", docId: DOC, projectId: PROJECT, at: T0 },
        { kind: "signed_in", shareId: "s2", docId: DOC, projectId: PROJECT, at: T1 },
      ],
      note: { text: "warm", byUserId: USER, at: T1 },
    });
    state.contact = doc;
    state.docRows = [{ _id: DOC, title: "Pitch deck" }];
    state.projectRows = [{ _id: PROJECT, name: "Data room", slug: "data-room" }];
    state.user = { name: "Chris" };

    const free = await getContact({ orgId: ORG, contactId: String(doc._id), identity: false });
    expect(free).not.toBeNull();
    expect(free).toMatchObject({ name: null, email: null, domain: "sequoiacap.com", introduced: false });
    expect(free!.docs).toEqual([{ docId: String(DOC), title: "Pitch deck", shareId: "s2", lastSeenAt: T1.toISOString() }]);
    expect(free!.projects).toEqual([{ projectId: String(PROJECT), name: "Data room", slug: "data-room" }]);
    expect(free!.note).toEqual({ text: "warm", byUserId: String(USER), byName: "Chris", at: T1.toISOString() });
    expect(free!.sources).toHaveLength(2);
    expect(findOne).toHaveBeenCalledWith({ _id: doc._id, orgId: ORG, isDeleted: { $ne: true } });

    const pro = await getContact({ orgId: ORG, contactId: String(doc._id), identity: true });
    expect(pro).toMatchObject({ name: "Priya Nair", email: "priya@sequoiacap.com" });
  });

  test("a contact in another workspace, or a malformed id, is null", async () => {
    state.contact = null;
    expect(await getContact({ orgId: ORG, contactId: String(new Types.ObjectId()), identity: true })).toBeNull();
    expect(await getContact({ orgId: ORG, contactId: "nope", identity: true })).toBeNull();
  });

  test("setContactNote writes who and when, clips to the limit, and an empty string clears", async () => {
    state.contact = contactDoc();
    state.plan = "pro";
    await setContactNote({ orgId: ORG, contactId: String((state.contact as { _id: Types.ObjectId })._id), userId: USER, text: "  " + "x".repeat(2500) + "  " });
    const [filter, update] = updateOne.mock.calls.at(-1) as unknown as [Record<string, unknown>, { $set: { note: { text: string; byUserId: Types.ObjectId; at: Date } | null } }];
    expect(filter).toMatchObject({ orgId: ORG, isDeleted: { $ne: true } });
    expect(update.$set.note!.text).toHaveLength(2000);
    expect(update.$set.note!.byUserId).toEqual(USER);
    expect(update.$set.note!.at).toBeInstanceOf(Date);

    await setContactNote({ orgId: ORG, contactId: String((state.contact as { _id: Types.ObjectId })._id), userId: USER, text: "" });
    const [, cleared] = updateOne.mock.calls.at(-1) as unknown as [unknown, { $set: { note: unknown } }];
    expect(cleared.$set.note).toBeNull();

    state.matchedCount = 0;
    expect(await setContactNote({ orgId: ORG, contactId: String(new Types.ObjectId()), userId: USER, text: "x" })).toBeNull();
  });
});

describe("contactIdentityAllowed", () => {
  test("Pro sees identity, Free does not, and a plan lookup failure is Free", async () => {
    state.plan = "pro";
    expect(await contactIdentityAllowed(ORG)).toBe(true);
    state.plan = "free";
    expect(await contactIdentityAllowed(ORG)).toBe(false);
    expect(await contactIdentityAllowed("not-an-org-id")).toBe(false);
  });
});

describe("CSV", () => {
  test("csvField quotes only what RFC 4180 requires and doubles inner quotes", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
    expect(csvField(3)).toBe("3");
    expect(csvField("has,comma")).toBe('"has,comma"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("line\nbreak")).toBe('"line\nbreak"');
    expect(csvField("cr\rhere")).toBe('"cr\rhere"');
  });

  test("the header is fixed and rows follow it, CRLF-terminated", () => {
    expect(CONTACTS_CSV_COLUMNS.join(",")).toBe("name,email,domain,verified,first_seen,last_seen,documents_read,projects,visits,tags,last_source");
    const csv = contactsToCsv([
      {
        id: "1",
        name: 'Nair, Priya "PN"',
        email: "priya@sequoiacap.com",
        domain: "sequoiacap.com",
        verified: true,
        introduced: true,
        firstSeenAt: T0.toISOString(),
        lastSeenAt: T1.toISOString(),
        documentsRead: 4,
        projectsCount: 1,
        visits: 9,
        tags: [
          { id: "a", name: "investor", slug: "investor", color: "sky" },
          { id: "b", name: "warm", slug: "warm", color: "jade" },
        ],
        lastSource: { kind: "introduced", at: T1.toISOString() },
      },
    ]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(CONTACTS_CSV_COLUMNS.join(","));
    expect(lines[1]).toBe(
      `"Nair, Priya ""PN""",priya@sequoiacap.com,sequoiacap.com,true,${T0.toISOString()},${T1.toISOString()},4,1,9,"investor, warm",introduced`,
    );
    expect(lines[2]).toBe("");
  });

  test("contactsCsv carries the same redaction as the page: empty name and email, never a placeholder", async () => {
    state.aggregateDocs = [
      contactDoc({ sources: [{ kind: "download_request", shareId: "s1", docId: DOC, projectId: null, at: T1 }] }),
    ];
    const csv = await contactsCsv({ orgId: ORG, identity: false });
    const row = csv.split("\r\n")[1];
    expect(row.startsWith(",,sequoiacap.com,false,")).toBe(true);
    expect(csv).not.toContain("Priya");
    expect(csv).not.toContain("priya@");
    expect(csv).not.toContain("Someone");

    state.plan = "pro";
    const full = await contactsCsv({ orgId: ORG, identity: true });
    expect(full.split("\r\n")[1].startsWith("Priya Nair,priya@sequoiacap.com,sequoiacap.com,")).toBe(true);
  });

  test("contactsCsv pages the query at 200 until a short page", async () => {
    state.aggregateDocs = [contactDoc()];
    await contactsCsv({ orgId: ORG, identity: true, sort: "name" });
    expect(aggregate).toHaveBeenCalledTimes(1);
    const pipeline = aggregate.mock.calls[0][0] as unknown as Array<Record<string, unknown>>;
    expect(pipeline.find((s) => "$limit" in s)).toEqual({ $limit: 200 });
    expect(pipeline.find((s) => "$sort" in s)).toEqual({ $sort: { name: 1, _id: 1 } });
  });
});
