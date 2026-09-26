/**
 * The `/api/contacts` routes: who may read, who may write, and that a filter asked for is the
 * filter answered.
 *
 * The service is mocked; these tests pin the route layer. Three things matter enough to pin:
 * the plan's identity flag rides on every response so a client can explain the blanks; the CSV
 * carries the same filters as the list (a "Download CSV" that forgot the tag filter hands the
 * whole workspace to a file); and the note PATCH refuses an API key before it reads the body,
 * because a note is a person's judgement about another person and "agents read contacts, and only
 * read" (docs/prds/lnkdrp-contacts.md, decision 10) is the rule the refusal enforces.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const USER = new Types.ObjectId().toString();
const ORG = new Types.ObjectId().toString();
const CONTACT_ID = new Types.ObjectId().toString();

const resolveActor = vi.fn();
const applyTempUserHeaders = vi.fn((res: Response) => res);
vi.mock("@/lib/gating/actor", () => ({ resolveActor, applyTempUserHeaders }));

/** The actor's role in the workspace; each test sets it. */
let role: "owner" | "admin" | "member" | "viewer" = "member";
const RANK = { viewer: 0, member: 1, admin: 2, owner: 3 } as const;
const requireOrgRole = vi.fn(async ({ minRole }: { minRole: keyof typeof RANK }) =>
  RANK[role] >= RANK[minRole] ? { ok: true as const, role } : { ok: false as const, status: 403 as const, error: "Forbidden" },
);
vi.mock("@/lib/orgs/requireOrgRole", () => ({ requireOrgRole }));

const listContacts = vi.fn();
const getContact = vi.fn();
const setContactNote = vi.fn();
const contactsCsv = vi.fn();
const contactIdentityAllowed = vi.fn();
vi.mock("@/lib/contacts/service", () => ({ listContacts, getContact, setContactNote, contactsCsv, contactIdentityAllowed }));

const recordActivity = vi.fn(async () => undefined);
vi.mock("@/lib/activity/log", () => ({ recordActivity }));

const connectMongo = vi.fn(async () => undefined);
vi.mock("@/lib/mongodb", () => ({ connectMongo }));
let orgSlug: string | null = "acme";
const orgFindById = vi.fn(() => ({ select: () => ({ lean: async () => (orgSlug === null ? null : { slug: orgSlug }) }) }));
vi.mock("@/lib/models/Org", () => ({ OrgModel: { findById: orgFindById } }));

// `/api/tags/assignments` is the other route that writes a contact, and the only other one an
// API key can reach. Its own models and tag service are stubbed; the guard under test is real.
const attachTag = vi.fn(async () => undefined);
const detachTag = vi.fn(async () => undefined);
const tagsForTarget = vi.fn(async () => [] as Array<{ id: string; name: string; slug: string; color: string }>);
const findOrCreateTag = vi.fn(async () => ({ tag: { id: new Types.ObjectId().toString(), name: "passed", slug: "passed", color: "sky" }, created: true }));
vi.mock("@/lib/tags/service", () => ({ attachTag, detachTag, tagsForTarget, findOrCreateTag }));
const contactFindOne = vi.fn(() => ({ select: () => ({ lean: async () => ({ _id: CONTACT_ID }) }) }));
vi.mock("@/lib/models/Contact", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/models/Contact")>()),
  ContactModel: { findOne: contactFindOne },
}));
const docFindOne = vi.fn(() => ({ select: () => ({ lean: async () => ({ _id: CONTACT_ID, primaryProjectId: null }) }) }));
vi.mock("@/lib/models/Doc", () => ({ DocModel: { findOne: docFindOne } }));
vi.mock("@/lib/models/Project", () => ({ ProjectModel: { findOne: () => ({ select: () => ({ lean: async () => null }) }) } }));
vi.mock("@/lib/billing/planLimits", () => ({ getWorkspacePlan: async () => "pro" }));

const { GET: listGet } = await import("@/app/api/contacts/route");
const { GET: exportGet } = await import("@/app/api/contacts/export/route");
const { GET: detailGet, PATCH: detailPatch } = await import("@/app/api/contacts/[contactId]/route");
const { POST: tagPost, DELETE: tagDelete } = await import("@/app/api/tags/assignments/route");

const signedIn = { kind: "user", userId: USER, orgId: ORG, personalOrgId: ORG } as const;
const viaKey = { ...signedIn, viaApiKey: { keyId: "key_1", scopes: ["read", "write"] } } as const;
const temp = { kind: "temp", userId: USER, orgId: ORG, personalOrgId: ORG, temp: { id: "t1" }, isNew: false } as const;

const EMPTY_PAGE = { items: [], total: 0, page: 1, limit: 50 };

/** A ContactDetail as the service would answer it, enough for the routes to pass through. */
function detail(overrides: Record<string, unknown> = {}) {
  return {
    id: CONTACT_ID,
    name: "Priya Nair",
    email: "priya@sequoiacap.com",
    domain: "sequoiacap.com",
    verified: true,
    introduced: true,
    firstSeenAt: "2026-09-01T00:00:00.000Z",
    lastSeenAt: "2026-09-20T00:00:00.000Z",
    documentsRead: 2,
    projectsCount: 1,
    visits: 5,
    tags: [],
    lastSource: { kind: "introduced", at: "2026-09-20T00:00:00.000Z" },
    sources: [],
    docs: [],
    projects: [],
    note: null,
    ...overrides,
  };
}

function ctx(contactId: string) {
  return { params: Promise.resolve({ contactId }) };
}

function patchRequest(body: unknown, id = CONTACT_ID) {
  return new Request(`http://localhost/api/contacts/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  role = "member";
  orgSlug = "acme";
  resolveActor.mockResolvedValue(signedIn);
  contactIdentityAllowed.mockResolvedValue(true);
  listContacts.mockResolvedValue(EMPTY_PAGE);
  contactsCsv.mockResolvedValue("name,email\r\n");
  getContact.mockResolvedValue(detail());
  setContactNote.mockResolvedValue(detail({ note: { text: "warm", byUserId: USER, byName: "Chris", at: "2026-09-25T00:00:00.000Z" } }));
});

describe("GET /api/contacts", () => {
  test("a temp user is 401 and the service is never asked", async () => {
    resolveActor.mockResolvedValue(temp);
    const res = await listGet(new Request("http://localhost/api/contacts"));
    expect(res.status).toBe(401);
    expect(listContacts).not.toHaveBeenCalled();
  });

  test("a viewer may read: the role check asks for viewer, not member", async () => {
    role = "viewer";
    const res = await listGet(new Request("http://localhost/api/contacts"));
    expect(res.status).toBe(200);
    expect(requireOrgRole).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, userId: USER, minRole: "viewer" }));
  });

  test("every filter, the sort and the page reach the service as asked", async () => {
    const docId = new Types.ObjectId().toString();
    const projectId = new Types.ObjectId().toString();
    const tagId = new Types.ObjectId().toString();
    const url =
      `http://localhost/api/contacts?q=priya&tagId=${tagId}&docId=${docId}&projectId=${projectId}` +
      `&shareId=abc123&domain=SequoiaCap.com&source=download_request&sort=documentsRead&dir=asc&page=3&limit=25`;
    const res = await listGet(new Request(url));
    expect(res.status).toBe(200);
    expect(listContacts).toHaveBeenCalledTimes(1);
    expect(listContacts).toHaveBeenCalledWith({
      orgId: ORG,
      identity: true,
      q: "priya",
      tagId,
      docId,
      projectId,
      shareId: "abc123",
      domain: "sequoiacap.com",
      source: "download_request",
      sort: "documentsRead",
      dir: "asc",
      page: 3,
      limit: 25,
    });
  });

  test("an unknown sort or source is dropped, a malformed id is refused", async () => {
    await listGet(new Request("http://localhost/api/contacts?sort=height&source=carrier_pigeon&dir=sideways"));
    expect(listContacts).toHaveBeenCalledWith(expect.objectContaining({ sort: undefined, dir: undefined, source: undefined }));

    listContacts.mockClear();
    const bad = await listGet(new Request("http://localhost/api/contacts?docId=not-an-id"));
    expect(bad.status).toBe(400);
    expect(listContacts).not.toHaveBeenCalled();
  });

  test("the identity flag comes from the plan and rides on the response", async () => {
    contactIdentityAllowed.mockResolvedValue(false);
    const res = await listGet(new Request("http://localhost/api/contacts"));
    const json = await res.json();
    expect(contactIdentityAllowed).toHaveBeenCalledWith(ORG);
    expect(json.identity).toBe(false);
    expect(listContacts).toHaveBeenCalledWith(expect.objectContaining({ identity: false }));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("the page comes back with items, total, page and limit", async () => {
    listContacts.mockResolvedValue({ items: [{ id: CONTACT_ID }], total: 1, page: 1, limit: 50 });
    const json = await (await listGet(new Request("http://localhost/api/contacts"))).json();
    expect(json).toEqual({ items: [{ id: CONTACT_ID }], total: 1, page: 1, limit: 50, identity: true });
  });
});

describe("GET /api/contacts/export", () => {
  test("a temp user is 401", async () => {
    resolveActor.mockResolvedValue(temp);
    const res = await exportGet(new Request("http://localhost/api/contacts/export"));
    expect(res.status).toBe(401);
    expect(contactsCsv).not.toHaveBeenCalled();
  });

  test("answers CSV as an attachment named after the workspace and the day", async () => {
    const res = await exportGet(new Request("http://localhost/api/contacts/export"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="contacts-acme-${today}.csv"`);
    expect(await res.text()).toBe("name,email\r\n");
  });

  test("falls back to the workspace id when there is no slug", async () => {
    orgSlug = null;
    const res = await exportGet(new Request("http://localhost/api/contacts/export"));
    expect(res.headers.get("content-disposition")).toContain(`contacts-${ORG}-`);
  });

  test("carries the same filters and sort as the list, and the plan's identity flag", async () => {
    contactIdentityAllowed.mockResolvedValue(false);
    const tagId = new Types.ObjectId().toString();
    await exportGet(new Request(`http://localhost/api/contacts/export?q=nair&tagId=${tagId}&source=introduced&sort=name&dir=asc&page=4`));
    expect(contactsCsv).toHaveBeenCalledWith({
      orgId: ORG,
      identity: false,
      q: "nair",
      tagId,
      docId: undefined,
      projectId: undefined,
      shareId: undefined,
      domain: undefined,
      source: "introduced",
      sort: "name",
      dir: "asc",
    });
  });
});

describe("GET /api/contacts/:contactId", () => {
  test("a temp user is 401", async () => {
    resolveActor.mockResolvedValue(temp);
    const res = await detailGet(new Request(`http://localhost/api/contacts/${CONTACT_ID}`), ctx(CONTACT_ID));
    expect(res.status).toBe(401);
  });

  test("a malformed id and an unknown contact are both 404", async () => {
    const bad = await detailGet(new Request("http://localhost/api/contacts/nope"), ctx("nope"));
    expect(bad.status).toBe(404);
    expect(getContact).not.toHaveBeenCalled();

    getContact.mockResolvedValue(null);
    const missing = await detailGet(new Request(`http://localhost/api/contacts/${CONTACT_ID}`), ctx(CONTACT_ID));
    expect(missing.status).toBe(404);
  });

  test("answers the contact with the identity flag, reading through the plan gate", async () => {
    contactIdentityAllowed.mockResolvedValue(false);
    const res = await detailGet(new Request(`http://localhost/api/contacts/${CONTACT_ID}`), ctx(CONTACT_ID));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(getContact).toHaveBeenCalledWith({ orgId: ORG, contactId: CONTACT_ID, identity: false });
    expect(json.identity).toBe(false);
    expect(json.contact.id).toBe(CONTACT_ID);
  });
});

describe("PATCH /api/contacts/:contactId", () => {
  test("an API key is refused before the body is read", async () => {
    resolveActor.mockResolvedValue(viaKey);
    // An empty body would be 400 if the key got that far; 403 means it never did.
    const res = await detailPatch(patchRequest("{}"), ctx(CONTACT_ID));
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json.error).toBe("api_key_forbidden");
    expect(json.message).toContain("write a contact note");
    expect(setContactNote).not.toHaveBeenCalled();
    expect(requireOrgRole).not.toHaveBeenCalled();
  });

  test("a temp user is 401", async () => {
    resolveActor.mockResolvedValue(temp);
    const res = await detailPatch(patchRequest({ note: "warm" }), ctx(CONTACT_ID));
    expect(res.status).toBe(401);
    expect(setContactNote).not.toHaveBeenCalled();
  });

  test("a viewer may not write the note", async () => {
    role = "viewer";
    const res = await detailPatch(patchRequest({ note: "warm" }), ctx(CONTACT_ID));
    expect(res.status).toBe(403);
    expect(requireOrgRole).toHaveBeenCalledWith(expect.objectContaining({ minRole: "member" }));
    expect(setContactNote).not.toHaveBeenCalled();
  });

  test("a note that is not a string, or longer than 2000 characters, is 400", async () => {
    expect((await detailPatch(patchRequest({ note: 42 }), ctx(CONTACT_ID))).status).toBe(400);
    expect((await detailPatch(patchRequest({}), ctx(CONTACT_ID))).status).toBe(400);
    expect((await detailPatch(patchRequest({ note: "x".repeat(2001) }), ctx(CONTACT_ID))).status).toBe(400);
    expect(setContactNote).not.toHaveBeenCalled();
  });

  test("a member writes the note, trimmed, and the edit lands in Activity", async () => {
    const res = await detailPatch(patchRequest({ note: "  warm, per Chris  " }), ctx(CONTACT_ID));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(setContactNote).toHaveBeenCalledWith({ orgId: ORG, contactId: CONTACT_ID, userId: USER, text: "warm, per Chris" });
    expect(json.contact.note.text).toBe("warm");
    expect(recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG,
        userId: USER,
        actorKind: "user",
        type: "contact.note_updated",
        meta: expect.objectContaining({ contactId: CONTACT_ID, cleared: false }),
      }),
    );
  });

  test("an empty string clears the note and says so in the activity row", async () => {
    setContactNote.mockResolvedValue(detail({ note: null }));
    const res = await detailPatch(patchRequest({ note: "" }), ctx(CONTACT_ID));
    expect(res.status).toBe(200);
    expect(setContactNote).toHaveBeenCalledWith(expect.objectContaining({ text: "" }));
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ cleared: true }) }));
  });

  test("the activity row names whoever the plan already un-redacted, and always carries the domain", async () => {
    const metaOf = () => (recordActivity.mock.calls.at(-1) as unknown as [{ meta: Record<string, unknown> }])[0].meta;

    // `setContactNote` hands back the DTO it has already redacted for this workspace's plan, so
    // the row copies what is there. On Pro that is the name and address even for someone who
    // never introduced themselves, which is what the sibling tag rows have always said.
    setContactNote.mockResolvedValue(detail({ introduced: false }));
    await detailPatch(patchRequest({ note: "warm" }), ctx(CONTACT_ID));
    expect(metaOf()).toEqual({
      contactId: CONTACT_ID,
      contactDomain: "sequoiacap.com",
      contactName: "Priya Nair",
      contactEmail: "priya@sequoiacap.com",
      cleared: false,
    });

    // A redacted contact arrives with name and email already null. The row omits both and keeps
    // the domain, so the feed reads "someone at sequoiacap.com" rather than "a contact".
    setContactNote.mockResolvedValue(detail({ introduced: false, name: null, email: null }));
    await detailPatch(patchRequest({ note: "warm" }), ctx(CONTACT_ID));
    expect(metaOf()).toEqual({ contactId: CONTACT_ID, contactDomain: "sequoiacap.com", cleared: false });

    // A webmail address has no domain to fall back on; the row is then the id alone.
    setContactNote.mockResolvedValue(detail({ introduced: false, name: null, email: null, domain: null }));
    await detailPatch(patchRequest({ note: "warm" }), ctx(CONTACT_ID));
    expect(metaOf()).toEqual({ contactId: CONTACT_ID, cleared: false });
  });

  test("an unknown contact is 404 and records nothing", async () => {
    setContactNote.mockResolvedValue(null);
    const res = await detailPatch(patchRequest({ note: "warm" }), ctx(CONTACT_ID));
    expect(res.status).toBe(404);
    expect(recordActivity).not.toHaveBeenCalled();
  });
});

/**
 * The other half of "agents read contacts, and only read" (decision 10).
 *
 * The note route refuses an API key and always has. Tagging a person is the same kind of claim
 * about someone else, and the help article says an agent cannot do it, but the tag route's only
 * gate was the workspace role, which a key passes. `lnkdrp_tag` never sends a contact target, so
 * the rule was being kept by the tool surface instead of by the API.
 */
describe("tagging a contact through /api/tags/assignments", () => {
  function tagRequest(body: unknown, method: "POST" | "DELETE" = "POST") {
    return new Request("http://localhost/api/tags/assignments", {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("an API key may not tag or untag a person, and is refused before the contact is looked up", async () => {
    resolveActor.mockResolvedValue(viaKey);

    const post = await tagPost(tagRequest({ targetKind: "contact", targetId: CONTACT_ID, name: "passed" }));
    expect(post.status).toBe(403);
    const posted = await post.json();
    expect(posted.error).toBe("api_key_forbidden");
    expect(posted.message).toContain("tag a person");
    expect(attachTag).not.toHaveBeenCalled();
    // Refused before the target check: a 404-versus-200 would itself say which contacts exist.
    expect(contactFindOne).not.toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();

    const del = await tagDelete(tagRequest({ targetKind: "contact", targetId: CONTACT_ID, tagId: new Types.ObjectId().toString() }, "DELETE"));
    expect(del.status).toBe(403);
    expect((await del.json()).message).toContain("untag a person");
    expect(detachTag).not.toHaveBeenCalled();
    expect(contactFindOne).not.toHaveBeenCalled();
  });

  test("a key may still tag a document: lnkdrp_tag is a documented agent capability for those", async () => {
    resolveActor.mockResolvedValue(viaKey);
    const tagId = new Types.ObjectId().toString();
    const res = await tagPost(tagRequest({ targetKind: "doc", targetId: new Types.ObjectId().toString(), tagId }));
    expect(res.status).toBe(200);
    expect(attachTag).toHaveBeenCalledWith(expect.objectContaining({ targetKind: "doc", tagId }));
  });

  test("a signed-in member may tag a person", async () => {
    const tagId = new Types.ObjectId().toString();
    const res = await tagPost(tagRequest({ targetKind: "contact", targetId: CONTACT_ID, tagId }));
    expect(res.status).toBe(200);
    expect(attachTag).toHaveBeenCalledWith(expect.objectContaining({ targetKind: "contact", targetId: CONTACT_ID, tagId }));
  });
});
