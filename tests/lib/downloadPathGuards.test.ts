/**
 * Three endpoints on the "someone outside the workspace wants this PDF" path, and what each of
 * them is allowed to do on the strength of an email address.
 *
 * - **`POST /api/download/:token/save`** proved that the signed-in caller's address matches the
 *   `requesterEmail` on an approved request — and then created a `Doc` in whatever workspace that
 *   person happened to be sitting in, with no role check at all. Matching the address says who the
 *   document was approved *for*; it says nothing about what they may write into a workspace they
 *   were invited to as a read-only `viewer`. Every other document-creating path calls
 *   `forbidUnlessOrgRole`; this one now does too.
 *
 * - **`POST /api/share/:shareId/download-requests`** is public and its only identity is the address
 *   typed into the form, so it has to stay safe when that address belongs to somebody else. It did
 *   not: a pending row older than the dedupe window was flipped to `denied` to keep "only one
 *   request actionable", which meant anyone holding the slug could post a recipient's address and
 *   silently kill the approve link already sitting in the owner's inbox — the owner clicks Approve,
 *   `approve/route.ts` sees `denied`, and nothing happens. The answer also named which branch ran
 *   (`created` / `resent` / `already_requested`), which is a lookup for "who has been asking this
 *   owner for the file". The stale row is now left alone and every accepted submission answers with
 *   the same body.
 *
 * - **`GET /api/projects/:id/links/:linkId/password`** is here as a regression pin, not a fix: its
 *   archived-link refusal already landed, and a secret that survives "delete this link" is exactly
 *   the kind of thing that grows back.
 *
 * Filter-and-call assertions in the style of tests/lib/crossTenantScoping.test.ts: the rules live in
 * the query and in which guard runs, not in the response mapping. The `ShareDownloadRequest.findOne`
 * mock deliberately *honours* the filter it is handed against a small in-memory row set — the whole
 * point of the dedupe fix is which rows the query can reach.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";
import { NextResponse } from "next/server";

const ORG = new Types.ObjectId();
const ME = new Types.ObjectId();
const OWNER = new Types.ObjectId();
const PROJECT = new Types.ObjectId();
const SOURCE_DOC = new Types.ObjectId();
const REQUEST_ROW = new Types.ObjectId();
const SHARE_ID = "SHAREslug01";
const RECIPIENT = "bob@example.com";

// --- shared module mocks -------------------------------------------------------------------------

const resolveActor = vi.fn();
const forbidUnlessOrgRole = vi.fn(async (_actor: unknown, _minRole?: unknown) => null as Response | null);
const docCreate = vi.fn(async (attrs: Record<string, unknown>) => ({ ...attrs, _id: new Types.ObjectId() }));
const docFindOne = vi.fn((_filter: Record<string, unknown>) => chain({
  _id: SOURCE_DOC,
  title: "Series A deck",
  fileName: "deck.pdf",
  blobUrl: "https://store123.public.blob.vercel-storage.com/deck.pdf",
}));
const userFindOne = vi.fn((_filter: Record<string, unknown>) => chain({ _id: ME, email: RECIPIENT }));

/** Rows the download-request dedupe query runs against, so the filter is what decides. */
type PendingRow = { _id: Types.ObjectId; shareId: string; requesterEmail: string; status: string; createdDate: Date };
let pendingRows: PendingRow[] = [];
const dedupeFilters: Array<Record<string, any>> = [];
const shareRequestUpdates: Array<{ filter: Record<string, any>; update: Record<string, any> }> = [];
const shareRequestCreate = vi.fn(async (attrs: Record<string, unknown>) => ({ ...attrs, _id: REQUEST_ROW }));

/**
 * `findOne` for `shareDownloadRequests`, applied to `pendingRows`. Understands exactly the clauses
 * the two routes use — including `createdDate: { $gt }`, which is the clause under test.
 */
const shareRequestFindOne = vi.fn((filter: Record<string, any>) => {
  if (filter?.claimTokenHash) {
    // The save route's lookup, not the dedupe one.
    return chain({ _id: REQUEST_ROW, requesterEmail: RECIPIENT, docId: SOURCE_DOC, shareId: SHARE_ID, savedDocId: null });
  }
  dedupeFilters.push(filter);
  const after = filter?.createdDate?.$gt instanceof Date ? (filter.createdDate.$gt as Date).getTime() : null;
  const row = pendingRows.find(
    (r) =>
      r.shareId === filter.shareId &&
      r.requesterEmail === filter.requesterEmail &&
      r.status === filter.status &&
      (after === null || r.createdDate.getTime() > after),
  );
  return chain(row ?? null);
});

const sendTextEmail = vi.fn(async (_args: unknown) => undefined);
const recordActivity = vi.fn();
const resolveShareLink = vi.fn();
const shareLinkUnlocked = vi.fn(() => true);
const listProjectLinks = vi.fn(async (_args: unknown) => [] as Array<Record<string, unknown>>);
const decryptSharePassword = vi.fn(() => "hunter2");
const accessProjectForLinks = vi.fn();
const forbidApiKey = vi.fn(() => null as Response | null);

/** Mongoose-ish chain that answers `.select()`, `.sort()` and `.lean()` in any order. */
function chain(value: unknown): any {
  const self: any = {
    select: () => self,
    sort: () => self,
    lean: async () => value,
    then: undefined,
  };
  return self;
}

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/gating/actor", () => ({
  resolveActor: (...a: unknown[]) => (resolveActor as never as (...x: unknown[]) => unknown)(...a),
  applyTempUserHeaders: (res: unknown) => res,
}));
vi.mock("@/lib/orgs/requireOrgEditor", () => ({
  forbidUnlessOrgRole: (...a: unknown[]) => (forbidUnlessOrgRole as never as (...x: unknown[]) => unknown)(...a),
}));
vi.mock("@/lib/gating/forbidApiKey", () => ({ forbidApiKey: (...a: unknown[]) => (forbidApiKey as never as (...x: unknown[]) => unknown)(...a) }));
vi.mock("@/lib/models/Doc", () => ({
  DocModel: {
    findOne: (...a: any[]) => (docFindOne as any)(...a),
    create: (...a: any[]) => (docCreate as any)(...a),
  },
}));
vi.mock("@/lib/models/User", () => ({ UserModel: { findOne: (...a: any[]) => (userFindOne as any)(...a) } }));
vi.mock("@/lib/models/ShareDownloadRequest", () => ({
  ShareDownloadRequestModel: {
    findOne: (...a: any[]) => (shareRequestFindOne as any)(...a),
    create: (...a: any[]) => (shareRequestCreate as any)(...a),
    updateOne: async (filter: Record<string, any>, update: Record<string, any>) => {
      shareRequestUpdates.push({ filter, update });
      return { modifiedCount: 1 };
    },
  },
}));
vi.mock("@/lib/models/Org", () => ({ ensurePersonalOrgForUserId: vi.fn(async () => ({ orgId: ORG })) }));
vi.mock("@/lib/share/links", () => ({
  resolveShareLink: (...a: unknown[]) => (resolveShareLink as never as (...x: unknown[]) => unknown)(...a),
  shareLinkUnlocked: (...a: unknown[]) => (shareLinkUnlocked as never as (...x: unknown[]) => unknown)(...a),
}));
vi.mock("@/lib/share/projectLinks", () => ({
  listProjectLinks: (...a: unknown[]) => (listProjectLinks as never as (...x: unknown[]) => unknown)(...a),
}));
vi.mock("@/lib/sharePassword", () => ({
  decryptSharePassword: (...a: unknown[]) => (decryptSharePassword as never as (...x: unknown[]) => unknown)(...a),
}));
vi.mock("@/app/api/projects/[projectSlug]/links/shared", () => ({
  accessProjectForLinks: (...a: unknown[]) => (accessProjectForLinks as never as (...x: unknown[]) => unknown)(...a),
  linkErrorResponse: (err: unknown) =>
    NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 }),
}));
vi.mock("@/lib/crypto/randomBase62", () => ({ newShareId: () => "MINTEDSLUG01", randomBase62: () => "aaaa" }));
vi.mock("@/lib/email/sendTextEmail", () => ({ sendTextEmail: (...a: unknown[]) => (sendTextEmail as never as (...x: unknown[]) => unknown)(...a) }));
vi.mock("@/lib/email/templates", () => ({
  downloadRequestOwnerEmail: () => ({ subject: "owner", text: "owner" }),
  downloadRequestReceivedEmail: () => ({ subject: "receipt", text: "receipt" }),
}));
vi.mock("@/lib/urls", () => ({
  getPublicSiteBase: () => "https://app.example",
  // The request page in the owner's email: a document link's page, or the room's document page.
  buildPublicShareUrl: (shareId: string) => `https://app.example/s/${shareId}`,
  buildPublicProjectUrl: (shareId: string) => `https://app.example/p/${shareId}`,
}));
vi.mock("@/lib/debug", () => ({ debugLog: vi.fn(), debugWarn: vi.fn(), debugError: vi.fn() }));
vi.mock("@/lib/http/rateLimit", () => ({
  clientIpFromRequest: () => "203.0.113.9",
  rateLimit: vi.fn(async () => ({ ok: true, retryAfterSec: 0 })),
  rateLimitedResponse: () => NextResponse.json({ error: "Too many" }, { status: 429 }),
}));
vi.mock("@/lib/http/errorResponse", () => ({
  errorJson: (err: unknown) =>
    NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 }),
}));
vi.mock("@/lib/activity/log", () => ({
  recordActivity: (...a: unknown[]) => (recordActivity as never as (...x: unknown[]) => unknown)(...a),
  agentFromRequest: () => null,
  agentLabel: () => null,
}));

const { POST: savePOST } = await import("@/app/api/download/[token]/save/route");
const { POST: requestPOST } = await import("@/app/api/share/[shareId]/download-requests/route");
const { GET: projectPasswordGET } = await import("@/app/api/projects/[projectSlug]/links/[linkId]/password/route");

// --- helpers -------------------------------------------------------------------------------------

function signedIn() {
  return { kind: "user", userId: String(ME), orgId: String(ORG), personalOrgId: String(ORG) };
}

/** A live link that needs no password: the ordinary case these routes serve. */
function liveLink() {
  return {
    link: { shareId: SHARE_ID, allowDownload: false, label: "Benchmark", isDefault: true },
    doc: { _id: SOURCE_DOC, title: "Series A deck", userId: OWNER, orgId: ORG },
    refusal: null,
  };
}

function requestCtx() {
  return { params: Promise.resolve({ shareId: SHARE_ID }) };
}

async function postDownloadRequest(email = RECIPIENT) {
  const res = await requestPOST(
    new Request(`http://localhost/api/share/${SHARE_ID}/download-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    }),
    requestCtx(),
  );
  return { res, body: (await res.json()) as Record<string, unknown> };
}

/** Every `updateOne` on the request row that sets `status: "denied"`. */
function denials() {
  return shareRequestUpdates.filter((u) => (u.update?.$set as Record<string, unknown> | undefined)?.status === "denied");
}

beforeEach(() => {
  vi.clearAllMocks();
  pendingRows = [];
  dedupeFilters.length = 0;
  shareRequestUpdates.length = 0;
  resolveActor.mockResolvedValue(signedIn());
  forbidUnlessOrgRole.mockResolvedValue(null);
  forbidApiKey.mockReturnValue(null);
  shareLinkUnlocked.mockReturnValue(true);
  resolveShareLink.mockResolvedValue(liveLink());
  userFindOne.mockImplementation(() => chain({ _id: ME, email: RECIPIENT }));
  docFindOne.mockImplementation(() =>
    chain({ _id: SOURCE_DOC, title: "Series A deck", fileName: "deck.pdf", blobUrl: "https://store123.public.blob.vercel-storage.com/deck.pdf" }),
  );
  docCreate.mockImplementation(async (attrs: Record<string, unknown>) => ({ ...attrs, _id: new Types.ObjectId() }));
  shareRequestCreate.mockImplementation(async (attrs: Record<string, unknown>) => ({ ...attrs, _id: REQUEST_ROW }));
});

// --- POST /api/download/:token/save --------------------------------------------------------------

describe("POST /api/download/:token/save", () => {
  const ctx = { params: Promise.resolve({ token: "claimtoken" }) };

  test("a viewer's claim never reaches DocModel.create", async () => {
    // The role gate is the workspace's answer, so the test speaks through it: a `viewer` gets the
    // 403 `requireOrgRole` builds. The bug was that the handler never asked — matching
    // `requesterEmail` was treated as authorisation to write into whatever workspace was active.
    forbidUnlessOrgRole.mockResolvedValueOnce(
      NextResponse.json({ error: "Your role cannot make changes in this workspace." }, { status: 403 }),
    );

    const res = await savePOST(new Request("http://localhost/api/download/claimtoken/save", { method: "POST" }), ctx);

    expect(res.status).toBe(403);
    expect(docCreate).not.toHaveBeenCalled();
    // And it refuses before it even looks the request row up, so a viewer cannot use this endpoint
    // to confirm that a given claim token is live.
    expect(shareRequestFindOne).not.toHaveBeenCalled();
  });

  test("the gate is the active workspace's, asked once, with the default (member) minimum", async () => {
    await savePOST(new Request("http://localhost/api/download/claimtoken/save", { method: "POST" }), ctx);
    expect(forbidUnlessOrgRole).toHaveBeenCalledTimes(1);
    const actor = forbidUnlessOrgRole.mock.calls[0]![0] as unknown as { orgId: string; userId: string };
    expect(actor.orgId).toBe(String(ORG));
    expect(actor.userId).toBe(String(ME));
    expect(forbidUnlessOrgRole.mock.calls[0]!.length).toBe(1);
  });

  test("an editor still gets the copy, and it is created unshared", async () => {
    const { status } = await savePOST(
      new Request("http://localhost/api/download/claimtoken/save", { method: "POST" }),
      { params: Promise.resolve({ token: "claimtoken" }) },
    );

    expect(status).toBe(200);
    expect(docCreate).toHaveBeenCalledTimes(1);
    const created = docCreate.mock.calls[0]![0] as Record<string, unknown>;
    // `shareEnabled: false` is why no `checkLimit(orgId, "documents")` sits beside the role gate:
    // the Free cap counts shared documents only, so this row adds nothing to it and a workspace at
    // its cap must still be able to receive a claim it was approved for.
    expect(created.shareEnabled).toBe(false);
    expect(String(created.orgId)).toBe(String(ORG));
  });
});

// --- POST /api/share/:shareId/download-requests --------------------------------------------------

describe("POST /api/share/:shareId/download-requests", () => {
  test("a stranger's submission never denies the pending row already in flight", async () => {
    // The recipient asked ten minutes ago and the owner's approve mail is sitting in their inbox.
    pendingRows = [
      {
        _id: new Types.ObjectId(),
        shareId: SHARE_ID,
        requesterEmail: RECIPIENT,
        status: "pending",
        createdDate: new Date(Date.now() - 10 * 60 * 1000),
      },
    ];

    const { body } = await postDownloadRequest(RECIPIENT);

    // The defect: that row was flipped to `denied` so "only one request remains actionable", which
    // made the owner's approve link a no-op — and anyone holding the slug could trigger it by
    // typing the recipient's address.
    expect(denials()).toEqual([]);
    // The dedupe read is bounded by the window itself, so a row outside it is not even reachable.
    expect(dedupeFilters).toHaveLength(1);
    expect(dedupeFilters[0]!.createdDate?.$gt).toBeInstanceOf(Date);
    // The resend still happens: a second live request for the same address is harmless, because
    // approving either one hands the same person the same document.
    expect(shareRequestCreate).toHaveBeenCalledTimes(1);
    expect(body.kind).toBe("created");
  });

  test("inside the window it is still one request, one pair of emails", async () => {
    pendingRows = [
      {
        _id: new Types.ObjectId(),
        shareId: SHARE_ID,
        requesterEmail: RECIPIENT,
        status: "pending",
        createdDate: new Date(Date.now() - 5 * 1000),
      },
    ];

    const { body } = await postDownloadRequest(RECIPIENT);

    expect(shareRequestCreate).not.toHaveBeenCalled();
    expect(sendTextEmail).not.toHaveBeenCalled();
    expect(denials()).toEqual([]);
    expect(body.kind).toBe("created");
  });

  test("the answer does not say whether that address already has a request outstanding", async () => {
    // Address with nothing pending.
    const fresh = await postDownloadRequest("nobody@example.com");

    // Same link, an address whose request is pending inside the window.
    vi.clearAllMocks();
    resolveShareLink.mockResolvedValue(liveLink());
    shareLinkUnlocked.mockReturnValue(true);
    pendingRows = [
      {
        _id: new Types.ObjectId(),
        shareId: SHARE_ID,
        requesterEmail: RECIPIENT,
        status: "pending",
        createdDate: new Date(Date.now() - 5 * 1000),
      },
    ];
    const pending = await postDownloadRequest(RECIPIENT);

    // Byte-identical, so the endpoint cannot be used to ask "who has been requesting this file?".
    // It used to answer `created` / `resent` / `already_requested` (with `retryAfterSeconds`), plus
    // `emailedOwner` and `emailedRequester`, all of which differ between these two calls.
    expect(fresh.res.status).toBe(pending.res.status);
    expect(JSON.stringify(pending.body)).toBe(JSON.stringify(fresh.body));
    expect(Object.keys(fresh.body).sort()).toEqual(["kind", "ok"]);
  });

  test("a password-protected link still refuses before any of this", async () => {
    shareLinkUnlocked.mockReturnValue(false);
    const { res } = await postDownloadRequest(RECIPIENT);
    expect(res.status).toBe(401);
    expect(shareRequestCreate).not.toHaveBeenCalled();
    expect(sendTextEmail).not.toHaveBeenCalled();
  });
});

// --- GET /api/projects/:id/links/:linkId/password ------------------------------------------------

describe("GET /api/projects/:id/links/:linkId/password", () => {
  const LINK = new Types.ObjectId();
  const ctx = { params: Promise.resolve({ projectSlug: String(PROJECT), linkId: String(LINK) }) };

  beforeEach(() => {
    accessProjectForLinks.mockResolvedValue({
      ok: true,
      access: { actor: signedIn(), projectId: PROJECT, orgId: ORG, name: "Data room" },
    });
  });

  test("a deleted link's password is gone, the same as on a document link", async () => {
    listProjectLinks.mockResolvedValue([
      { _id: LINK, shareId: SHARE_ID, label: "Benchmark", passwordHash: "h", passwordEnc: "e", archivedAt: new Date() },
    ]);

    const res = await projectPasswordGET(new Request("http://localhost/x"), ctx);

    expect(res.status).toBe(404);
    // Never decrypted, so "delete this link" means the same thing here as it does on a document —
    // and no `share_link.password_revealed` row claims a live secret left the system.
    expect(decryptSharePassword).not.toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();
  });

  test("a live link still reveals, because that is what the route is for", async () => {
    listProjectLinks.mockResolvedValue([
      { _id: LINK, shareId: SHARE_ID, label: "Benchmark", passwordHash: "h", passwordEnc: "e", archivedAt: null },
    ]);

    const res = await projectPasswordGET(new Request("http://localhost/x"), ctx);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toEqual({ passwordEnabled: true, password: "hunter2" });
    expect(recordActivity).toHaveBeenCalledTimes(1);
  });
});
