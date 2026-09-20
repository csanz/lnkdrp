/**
 * Three leftovers from before workspaces existed, each on a surface whose *neighbours* were
 * already scoped correctly — which is why none of them showed up as a bug report.
 *
 * - `/api/docs/:id/history/:v/viewer/:userId` proved the **document** belonged to the caller and
 *   then read `users` by the id in the path, so the answer to "who is this?" came back for any id
 *   in any tenant.
 * - `GET /api/docs` backfills a missing `shareId` while listing. The listing filter is tenanted;
 *   the write underneath it was anchored on the document id alone, so the read's scoping was the
 *   only thing keeping a public slug off another tenant's unshared draft.
 * - `GET /api/uploads` filtered on `userId` and never read `actor.orgId`, so "who uploaded it" was
 *   the whole access decision — and both an `lnk_` key scoped to a different workspace and a
 *   removed member's session are the same person by that measure.
 *
 * These are pinned as filters-issued assertions (the style of tests/lib/docMetricsScope.test.ts),
 * because the rule lives in the query, not in the response mapping.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";
import { NextResponse } from "next/server";

const TEAM_ORG = new Types.ObjectId().toString();
const PERSONAL_ORG = new Types.ObjectId().toString();
const ME = new Types.ObjectId().toString();
/** A user id belonging to nobody the caller has any relationship with. */
const STRANGER = new Types.ObjectId().toString();
const DOC = new Types.ObjectId();

// --- shared module mocks -----------------------------------------------------------------------

const connectMongo = vi.fn(async () => undefined);
const resolveActor = vi.fn();
const tryResolveUserActorFastWithPersonalOrg = vi.fn(async () => null);
const applyTempUserHeaders = vi.fn((res: unknown) => res);

const docExists = vi.fn(async () => ({ _id: DOC }));
const docCountDocuments = vi.fn(async (_filter: Record<string, any>) => 1);
const docFind = vi.fn((_filter: Record<string, any>) => ({}) as any);
const docUpdateOne = vi.fn(async (_filter: Record<string, any>, ..._rest: unknown[]) => ({
  matchedCount: 1,
  modifiedCount: 1,
}));
const userFindById = vi.fn((..._a: unknown[]) => ({}) as any);
const pageTimingAggregate = vi.fn(async (_stages: Array<Record<string, any>>) => [] as unknown[]);
const uploadCountDocuments = vi.fn(async (_filter: Record<string, any>) => 0);
const uploadFind = vi.fn((_filter: Record<string, any>) => ({}) as any);
const projectFind = vi.fn((_filter: Record<string, any>) => ({}) as any);

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/gating/actor", () => ({
  resolveActor,
  applyTempUserHeaders,
  tryResolveUserActorFastWithPersonalOrg,
}));
vi.mock("@/lib/billing/planLimits", () => ({
  checkLimit: vi.fn(async () => ({ ok: true })),
  planLimitResponse: vi.fn(() => NextResponse.json({ error: "plan_limit" }, { status: 402 })),
}));
vi.mock("@/lib/models/Doc", () => ({
  DocModel: {
    exists: (...a: any[]) => (docExists as any)(...a),
    countDocuments: (...a: any[]) => (docCountDocuments as any)(...a),
    find: (...a: any[]) => (docFind as any)(...a),
    updateOne: (...a: any[]) => (docUpdateOne as any)(...a),
  },
  allocateDocUploadVersion: vi.fn(),
}));
vi.mock("@/lib/models/User", () => ({ UserModel: { findById: (...a: any[]) => (userFindById as any)(...a) } }));
vi.mock("@/lib/models/DocPageTiming", () => ({
  DocPageTimingModel: { aggregate: (...a: any[]) => (pageTimingAggregate as any)(...a) },
}));
vi.mock("@/lib/models/Upload", () => ({
  UploadModel: {
    countDocuments: (...a: any[]) => (uploadCountDocuments as any)(...a),
    find: (...a: any[]) => (uploadFind as any)(...a),
  },
}));
vi.mock("@/lib/models/Project", () => ({ ProjectModel: { find: (...a: any[]) => (projectFind as any)(...a) } }));
vi.mock("@/lib/models/ShareLink", () => ({
  DOC_LINK_FILTER: { kind: "doc" },
  ShareLinkModel: { find: () => ({ select: () => ({ limit: () => ({ lean: async () => [] }) }) }) },
}));
vi.mock("@/lib/crypto/randomBase62", () => ({
  newShareId: () => "MINTEDSLUG01",
  randomBase62: () => "aaaa",
}));
vi.mock("@/lib/debug", () => ({ debugLog: vi.fn(), debugError: vi.fn() }));
vi.mock("@/lib/http/errorResponse", () => ({
  errorJson: (err: unknown) =>
    NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 }),
}));
vi.mock("@/lib/gating/actorRateLimit", () => ({ actorRateLimitResponse: () => null }));
vi.mock("@/lib/orgs/requireOrgEditor", () => ({ forbidUnlessOrgRole: vi.fn(async () => null) }));
vi.mock("@/lib/activity/log", () => ({
  recordActivity: vi.fn(),
  agentFromRequest: () => null,
  agentLabel: () => null,
}));
vi.mock("@/lib/share/links", () => ({ ensureDefaultLink: vi.fn() }));
vi.mock("@/lib/share/createdVia", () => ({ createdViaFor: () => "web" }));
vi.mock("@/lib/ai/agentSummary", () => ({
  INVALID_SUMMARY_CODE: "invalid_summary",
  parseAgentSummaryInput: () => ({ ok: true, value: null }),
}));
vi.mock("@/lib/uploads/progress", () => ({
  uploadProgressFor: () => ({ percent: 0, stage: "created", stageKey: "created" }),
}));
vi.mock("@/lib/blob/serverClientUploadRoute", () => ({
  isPdfUploadMeta: () => true,
  PDF_ONLY_ERROR_MESSAGE: "pdf only",
  UNSUPPORTED_FILE_TYPE_CODE: "unsupported_file_type",
}));

const { GET: viewerGET } = await import("@/app/api/docs/[docId]/history/[version]/viewer/[userId]/route");
const { GET: docsGET } = await import("@/app/api/docs/route");
const { GET: uploadsGET } = await import("@/app/api/uploads/route");

// --- helpers -----------------------------------------------------------------------------------

/** Signed in, sitting in a team workspace: legacy `userId`-only rows must never resolve. */
function inTeamWorkspace() {
  return { kind: "user", userId: ME, orgId: TEAM_ORG, personalOrgId: PERSONAL_ORG };
}
/** Signed in, sitting in their own personal workspace: pre-workspace rows are theirs to see. */
function inPersonalWorkspace() {
  return { kind: "user", userId: ME, orgId: PERSONAL_ORG, personalOrgId: PERSONAL_ORG };
}

function docsChain(rows: unknown[]) {
  return {
    select: () => ({
      sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => rows }) }) }),
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  applyTempUserHeaders.mockImplementation((res: unknown) => res);
  resolveActor.mockResolvedValue(inTeamWorkspace());
  tryResolveUserActorFastWithPersonalOrg.mockResolvedValue(null);
  docExists.mockResolvedValue({ _id: DOC });
  docCountDocuments.mockResolvedValue(1);
  docUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
  pageTimingAggregate.mockResolvedValue([]);
  uploadCountDocuments.mockResolvedValue(0);
  uploadFind.mockReturnValue({
    sort: () => ({ skip: () => ({ limit: () => ({ populate: () => ({ lean: async () => [] }) }) }) }),
  });
  projectFind.mockReturnValue({ select: () => ({ lean: async () => [] }) });
  docFind.mockReturnValue(docsChain([]));
});

// --- the history viewer drill-down ---------------------------------------------------------------

describe("GET /api/docs/:docId/history/:version/viewer/:userId", () => {
  const ctx = (userId: string) =>
    ({ params: Promise.resolve({ docId: String(DOC), version: "1", userId }) });

  test("a stranger's id in the path never reaches the users collection", async () => {
    const res = await viewerGET(new Request("http://localhost/x"), ctx(STRANGER));
    const json = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    // The leak: `UserModel.findById(userId)` with no org, membership or "did they open this?"
    // constraint. One signed-in owner of one document could name any id and be told the name and
    // email behind it — and ObjectIds sit next to their neighbours, so it enumerated.
    expect(userFindById).not.toHaveBeenCalled();
    expect(json).not.toHaveProperty("viewer");
  });

  test("the timings it does answer with are bounded by the caller's org", async () => {
    await viewerGET(new Request("http://localhost/x"), ctx(STRANGER));
    const match = (pageTimingAggregate.mock.calls[0]![0] as Array<Record<string, any>>)[0]!.$match;
    expect(String(match.orgId)).toBe(TEAM_ORG);
    expect(String(match.docId)).toBe(String(DOC));
    // So an unrelated id is an empty `pages: []` rather than anyone else's reading.
    expect(String(match.viewerUserId)).toBe(STRANGER);
  });

  test("a document outside the workspace is still 404, before the plan gate", async () => {
    docExists.mockResolvedValueOnce(null as never);
    const res = await viewerGET(new Request("http://localhost/x"), ctx(STRANGER));
    expect(res.status).toBe(404);
    expect(pageTimingAggregate).not.toHaveBeenCalled();
  });
});

// --- the shareId backfill inside the listing -----------------------------------------------------

describe("GET /api/docs shareId backfill", () => {
  beforeEach(() => {
    docFind.mockReturnValue(docsChain([{ _id: DOC, orgId: new Types.ObjectId(TEAM_ORG), shareId: null }]));
  });

  test("the mint names the caller's workspace, not just the document id", async () => {
    await docsGET(new Request("http://localhost/api/docs"));
    const filter = docUpdateOne.mock.calls.at(-1)![0] as Record<string, any>;

    // The bug: `{ _id, shareId: { $in: [null, undefined, ""] } }` and nothing else. A public
    // `/s/:slug` is minted here and `ensureDefaultLink` turns it into a live link, so a document
    // the caller does not own must not match.
    expect(String(filter.orgId)).toBe(TEAM_ORG);
    expect(filter.shareId).toEqual({ $in: [null, undefined, ""] });
  });

  test("in a personal workspace it still refuses everything but this caller's own rows", async () => {
    resolveActor.mockResolvedValue(inPersonalWorkspace());
    docFind.mockReturnValue(docsChain([{ _id: DOC, orgId: new Types.ObjectId(PERSONAL_ORG), shareId: null }]));

    await docsGET(new Request("http://localhost/api/docs"));
    const filter = docUpdateOne.mock.calls.at(-1)![0] as Record<string, any>;
    const arms = filter.$or as Array<Record<string, any>>;

    // Two ways to own it and no third: this workspace's row, or a pre-workspace row of this
    // person's that carries no orgId at all.
    expect(arms).toHaveLength(2);
    expect(String(arms[0]!.orgId)).toBe(PERSONAL_ORG);
    expect(String(arms[1]!.userId)).toBe(ME);
    expect(arms[1]!.$or).toEqual([{ orgId: { $exists: false } }, { orgId: null }]);
    expect(arms.every((a) => String(a._id) === String(DOC))).toBe(true);
  });

  test("a slug the write declined is not reported as if it had been minted", async () => {
    docUpdateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
    const res = await docsGET(new Request("http://localhost/api/docs"));
    const json = (await res.json()) as { docs: Array<{ shareId: string | null }> };
    expect(json.docs[0]!.shareId).toBeNull();
  });

  test("a document that already has a slug is left alone", async () => {
    docFind.mockReturnValue(docsChain([{ _id: DOC, orgId: new Types.ObjectId(TEAM_ORG), shareId: "existing1234" }]));
    await docsGET(new Request("http://localhost/api/docs"));
    expect(docUpdateOne).not.toHaveBeenCalled();
  });
});

// --- the uploads listing -------------------------------------------------------------------------

describe("GET /api/uploads", () => {
  test("the listing is bounded by the workspace, not only by who uploaded", async () => {
    await uploadsGET(new Request("http://localhost/api/uploads?limit=50"));
    const filter = uploadCountDocuments.mock.calls[0]![0] as Record<string, any>;

    // The bug: `{ isDeleted, userId }` and no orgId anywhere. An `lnk_` key minted in another
    // workspace resolves to the member who created it, so by `userId` alone it was indistinguishable
    // from that person signing in — and so was a member who had been removed.
    expect(String(filter.userId)).toBe(ME);
    expect(filter.$and).toEqual([{ orgId: new Types.ObjectId(TEAM_ORG) }]);
    expect(filter.isDeleted).toEqual({ $ne: true });
  });

  test("the same bound reaches the `find`, not only the count", async () => {
    await uploadsGET(new Request("http://localhost/api/uploads"));
    const filter = uploadFind.mock.calls[0]![0] as Record<string, any>;
    expect(filter.$and).toEqual([{ orgId: new Types.ObjectId(TEAM_ORG) }]);
  });

  test("a search term cannot replace the workspace bound", async () => {
    docFind.mockReturnValue({ select: () => ({ limit: () => ({ lean: async () => [{ _id: DOC }] }) }) });
    await uploadsGET(new Request("http://localhost/api/uploads?q=deck"));
    const filter = uploadCountDocuments.mock.calls[0]![0] as Record<string, any>;

    // Why `$and` and not `filter.$or = [...]`: assigning `$or` is exactly how document search in
    // `/api/docs` lost its tenancy clause once already.
    expect(filter.$or).toBeUndefined();
    expect(filter.$and).toHaveLength(2);
    expect(filter.$and[0]).toEqual({ orgId: new Types.ObjectId(TEAM_ORG) });
    expect(filter.$and[1].$or[0]).toHaveProperty("originalFileName");
  });

  test("the title lookup behind `?q=` is tenanted the same way", async () => {
    docFind.mockReturnValue({ select: () => ({ limit: () => ({ lean: async () => [] }) }) });
    await uploadsGET(new Request("http://localhost/api/uploads?q=deck"));
    const filter = docFind.mock.calls[0]![0] as Record<string, any>;
    expect(String(filter.orgId)).toBe(TEAM_ORG);
    // No `{ userId }` arm in a team workspace: that arm is what let a removed member probe for
    // titles in the workspace they had left.
    expect(filter.$or).toBeUndefined();
  });

  test("pre-workspace rows resolve only from the owner's own personal workspace", async () => {
    resolveActor.mockResolvedValue(inPersonalWorkspace());
    await uploadsGET(new Request("http://localhost/api/uploads"));
    const filter = uploadCountDocuments.mock.calls[0]![0] as Record<string, any>;
    expect(filter.$and).toEqual([
      { $or: [{ orgId: new Types.ObjectId(PERSONAL_ORG) }, { orgId: { $exists: false } }, { orgId: null }] },
    ]);
  });
});
