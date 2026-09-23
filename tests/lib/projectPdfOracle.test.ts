/**
 * The locked data room's inventory oracle, one path deeper than the one that was already closed.
 *
 * `/p/:shareId/:docId` stopped confirming which documents a password-protected room holds
 * (tests/lib/roomDisclosure.test.ts pins that), but its PDF proxy — `/p/:shareId/:docId/pdf` — kept
 * the original ordering: resolve the document, 404 `Not found` for an id that is not in the room,
 * 404 `PDF not available` for one that is but has no bytes, and only *then* 401 for a locked link
 * with no share-auth cookie. So walking candidate ids against the proxy with no cookie sorted them
 * into "in this room" and "not in this room" just as reliably as the page used to, which made the
 * page fix cosmetic: the room's contents were still enumerable, one URL at a time.
 *
 * The fix is the same pure reordering the page took: link, link-level refusals, password, *then*
 * membership. What is pinned here is the ordering itself — every locked answer is byte-identical,
 * and `findProjectDocument` is not called at all while the gate is up, so there is not even a
 * timing difference to read. Everything downstream of the gate is pinned too, because the point is
 * that only the order changed: behind the cookie a non-member id is a 404 again, the
 * `allowDownload` gate still refuses, and a permitted download still writes its analytics rows.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const SHARE_ID = "pl_locked01";
const ORG = new Types.ObjectId();
const OWNER = new Types.ObjectId();
const PROJECT = new Types.ObjectId();
const LINK = new Types.ObjectId();

/** A document that really is in the locked room. */
const MEMBER_DOC = new Types.ObjectId().toString();
/** A plausible id that is not — what an attacker walking the id space is holding. */
const OUTSIDER_DOC = new Types.ObjectId().toString();
/** In the room, but with nothing to serve: the third answer the old ordering handed out. */
const BYTELESS_DOC = new Types.ObjectId().toString();

const UNLOCK_COOKIE = "the-unlock-cookie";

// --- module mocks ------------------------------------------------------------------------------

const resolveProjectLink = vi.fn();
vi.mock("@/lib/share/projectLinks", () => ({
  resolveProjectLink: (...a: any[]) => (resolveProjectLink as any)(...a),
}));

const findProjectDocument = vi.fn();
vi.mock("@/lib/share/projectPublic", () => ({
  findProjectDocument: (...a: any[]) => (findProjectDocument as any)(...a),
  // The real predicate: it is pure, and it is the thing that decides "locked".
  projectLinkPasswordEnabled: (link: any) => Boolean(link?.passwordHash) && Boolean(link?.passwordSalt),
  projectViewerKey: (hash: string, docId: unknown) => `${hash}.${String(docId)}`,
}));

vi.mock("@/lib/sharePassword", () => ({
  shareAuthCookieName: (id: string) => `share_auth_${id}`,
  shareAuthCookieValue: () => UNLOCK_COOKIE,
}));

const shareViewUpdateOne = vi.fn(async (..._a: unknown[]) => ({ upsertedCount: 1 }));
const projectLinkViewUpdateOne = vi.fn(async (..._a: unknown[]) => ({ upsertedCount: 1 }));
const touchShareLink = vi.fn(async (..._a: unknown[]) => undefined);
const recordActivity = vi.fn(async (..._a: unknown[]) => undefined);

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/debug", () => ({ debugError: vi.fn(), debugLog: vi.fn() }));
vi.mock("@/lib/models/ShareView", () => ({
  // The routes cap the download instants they push; a mocked module without it throws on access.
  DOWNLOAD_INSTANTS_KEPT: 50,
  ShareViewModel: {
    updateOne: (...a: unknown[]) => (shareViewUpdateOne as any)(...a),
    // The activity feed's name lookup: `.select().lean().catch()`.
    findOne: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }),
  },
}));
vi.mock("@/lib/models/ProjectLinkView", () => ({
  ProjectLinkViewModel: { updateOne: (...a: unknown[]) => (projectLinkViewUpdateOne as any)(...a) },
}));
vi.mock("@/lib/models/Org", () => ({ ensurePersonalOrgForUserId: vi.fn(async () => ({ orgId: ORG })) }));
vi.mock("@/lib/activity/log", () => ({ recordActivity: (...a: unknown[]) => (recordActivity as any)(...a) }));
vi.mock("@/lib/share/links", () => ({ touchShareLink: (...a: unknown[]) => (touchShareLink as any)(...a) }));
vi.mock("@/lib/share/ownerSide", () => ({ isOwnerSideViewer: vi.fn(async () => false) }));
vi.mock("@/lib/gating/actor", () => ({ tryResolveAuthUserId: vi.fn(async () => null) }));
vi.mock("@/lib/http/rateLimit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/http/rateLimit")>();
  return { ...actual, rateLimit: vi.fn(async () => ({ ok: true, remaining: 29, retryAfterSec: 0 })) };
});

import { GET } from "@/app/p/[shareId]/[docId]/pdf/route";

// --- fixtures ----------------------------------------------------------------------------------

const lockedLink = { _id: LINK, orgId: ORG, passwordHash: "hash", passwordSalt: "salt", allowDownload: true, label: null, isDefault: true };
const openLink = { _id: LINK, orgId: ORG, passwordHash: null, passwordSalt: null, allowDownload: true, label: null, isDefault: true };
const project = { _id: PROJECT, name: "Data room", orgId: ORG, isRequest: false };

const memberDoc = { _id: MEMBER_DOC, blobUrl: "https://store123.public.blob.vercel-storage.com/deck.pdf", title: "Term sheet", fileName: "term-sheet.pdf", orgId: ORG, userId: OWNER };
const bytelessDoc = { _id: BYTELESS_DOC, blobUrl: "", title: "Still processing", fileName: null, orgId: ORG, userId: OWNER };

/** The room's real contents, so the old code's three-way split has something to split on. */
function roomHolds(_project: unknown, docId: unknown) {
  const id = String(docId);
  if (id === MEMBER_DOC) return Promise.resolve(memberDoc);
  if (id === BYTELESS_DOC) return Promise.resolve(bytelessDoc);
  return Promise.resolve(null);
}

/** Let the route's fire-and-forget analytics writes land. */
async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
}

async function get(docId: string, opts: { cookie?: string; query?: string } = {}) {
  const res = await GET(
    new Request(`http://localhost/p/${SHARE_ID}/${docId}/pdf${opts.query ?? ""}`, {
      headers: opts.cookie ? { cookie: `share_auth_${SHARE_ID}=${opts.cookie}` } : {},
    }),
    { params: Promise.resolve({ shareId: SHARE_ID, docId }) },
  );
  await settle();
  return res;
}

/** Status plus body, because "the same answer" has to mean the bytes too, not just the code. */
async function answer(docId: string, opts: { cookie?: string; query?: string } = {}) {
  const res = await get(docId, opts);
  return { status: res.status, body: await res.clone().text() };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveProjectLink.mockResolvedValue({ link: lockedLink, project, refusal: null });
  findProjectDocument.mockImplementation(roomHolds);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { "content-length": "4" } })),
  );
});

describe("a locked room's PDF proxy does not confirm which documents are inside it", () => {
  test("a document that is in the room gets the password answer", async () => {
    expect(await answer(MEMBER_DOC)).toEqual({ status: 401, body: "Unauthorized" });
  });

  test("a document that is not in the room gets exactly the same answer", async () => {
    expect(await answer(OUTSIDER_DOC)).toEqual(await answer(MEMBER_DOC));
  });

  test("a document in the room with no bytes yet gets it too", async () => {
    // The old ordering leaked this one separately: `PDF not available` said "that id is in here"
    // just as loudly as a 200 would have.
    expect(await answer(BYTELESS_DOC)).toEqual({ status: 401, body: "Unauthorized" });
  });

  test("a malformed id is indistinguishable from a real one", async () => {
    expect(await answer("not-an-object-id")).toEqual({ status: 401, body: "Unauthorized" });
  });

  test("the room is never asked whether it holds the document before the password", async () => {
    await get(OUTSIDER_DOC);
    await get(MEMBER_DOC);
    await get(BYTELESS_DOC);
    // This is the fix: membership is not consulted at all while the gate is up, so there is no
    // answer for it to differ on — not even a timing one.
    expect(findProjectDocument).not.toHaveBeenCalled();
  });

  test("no analytics row is written for a probe either", async () => {
    await get(MEMBER_DOC, { query: "?download=1&botId=probe" });
    expect(shareViewUpdateOne).not.toHaveBeenCalled();
    expect(projectLinkViewUpdateOne).not.toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();
  });

  test("a wrong cookie is a probe as well", async () => {
    expect(await answer(MEMBER_DOC, { cookie: "not-the-unlock-cookie" })).toEqual({ status: 401, body: "Unauthorized" });
    expect(findProjectDocument).not.toHaveBeenCalled();
  });
});

describe("behind the password the proxy answers normally again", () => {
  test("a member document is served", async () => {
    const res = await get(MEMBER_DOC, { cookie: UNLOCK_COOKIE });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("inline");
  });

  test("a non-member id is a 404 — the caller has the password, so this is no longer a secret", async () => {
    expect(await answer(OUTSIDER_DOC, { cookie: UNLOCK_COOKIE })).toEqual({ status: 404, body: JSON.stringify({ error: "Not found" }) });
  });

  test("a member document with no bytes says so", async () => {
    expect(await answer(BYTELESS_DOC, { cookie: UNLOCK_COOKIE })).toEqual({
      status: 404,
      body: JSON.stringify({ error: "PDF not available" }),
    });
  });

  test("a permitted download still counts", async () => {
    await get(MEMBER_DOC, { cookie: UNLOCK_COOKIE, query: "?download=1&botId=reader-1" });

    expect(shareViewUpdateOne).toHaveBeenCalledTimes(1);
    expect(projectLinkViewUpdateOne).toHaveBeenCalledTimes(1);
    expect(touchShareLink).toHaveBeenCalled();
  });

  test("the link's download gate still refuses, password or no password", async () => {
    resolveProjectLink.mockResolvedValue({ link: { ...lockedLink, allowDownload: false }, project, refusal: null });
    const res = await get(MEMBER_DOC, { cookie: UNLOCK_COOKIE, query: "?download=1&botId=reader-1" });

    expect(res.status).toBe(403);
    expect(shareViewUpdateOne).not.toHaveBeenCalled();
  });
});

describe("the link is still resolved first, and its refusals still come before the gate", () => {
  test("an unknown slug is a 404 and asks the room nothing", async () => {
    resolveProjectLink.mockResolvedValue(null);
    expect(await answer(MEMBER_DOC)).toEqual({ status: 404, body: JSON.stringify({ error: "Not found" }) });
    expect(findProjectDocument).not.toHaveBeenCalled();
  });

  test("a refused link answers the same way for a member and a non-member id", async () => {
    // Expiry is a property of the link the recipient already holds, not of its contents, so it
    // stays ahead of the gate — and it must not become an oracle of its own on the way past.
    resolveProjectLink.mockResolvedValue({ link: lockedLink, project, refusal: "expired" });

    expect(await answer(MEMBER_DOC)).toEqual({ status: 404, body: JSON.stringify({ error: "Not found" }) });
    expect(await answer(OUTSIDER_DOC)).toEqual({ status: 404, body: JSON.stringify({ error: "Not found" }) });
    expect(findProjectDocument).not.toHaveBeenCalled();
  });

  test("a request repo is a 404 by deep link, gate or no gate", async () => {
    resolveProjectLink.mockResolvedValue({ link: lockedLink, project: { ...project, isRequest: true }, refusal: null });
    expect(await answer(MEMBER_DOC, { cookie: UNLOCK_COOKIE })).toEqual({ status: 404, body: JSON.stringify({ error: "Not found" }) });
    expect(findProjectDocument).not.toHaveBeenCalled();
  });

  test("an unlocked room is untouched: member served, non-member 404", async () => {
    resolveProjectLink.mockResolvedValue({ link: openLink, project, refusal: null });

    expect((await get(MEMBER_DOC)).status).toBe(200);
    expect(await answer(OUTSIDER_DOC)).toEqual({ status: 404, body: JSON.stringify({ error: "Not found" }) });
  });
});
