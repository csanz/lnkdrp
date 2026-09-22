/**
 * The third write sibling in `src/app/api/uploads/`, left behind by the fix the other two got.
 *
 * `GET /api/uploads`, `GET /api/uploads/:uploadId`, import-url and import-bytes were all scoped by
 * `userId` alone and were all given a workspace bound (see tests/lib/importTenancy.test.ts and
 * tests/lib/crossTenantScoping.test.ts). `POST /api/uploads/:uploadId/process` kept the old rule
 * under the same misleading comment, and it is the expensive one: it runs the AI passes and bills
 * them to the *document's* workspace (`existingDocOrgId`), while the only other gate,
 * `forbidUnlessOrgRole`, grades the caller's role in the workspace they happen to be in now.
 *
 * So a member removed from workspace A (their upload rows there are still theirs by `userId`), a
 * member demoted to `viewer` in A, or an `lnk_` key minted in workspace B, all passed both checks
 * and re-triggered owner-billed processing on A's document.
 *
 * Two locks, pinned separately because they answer different questions:
 * 1. the filter the route issues for the upload names the workspace, not only the uploader;
 * 2. the document that gets the bill is the caller's workspace's document, checked before anything
 *    is claimed or scheduled, because the credits preflight reads `actor.orgId` and the job charges
 *    the document's org.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const TEAM_ORG = new Types.ObjectId().toString();
const PERSONAL_ORG = new Types.ObjectId().toString();
/** The workspace the caller was removed from / never had: it owns the document and the credits. */
const VICTIM_ORG = new Types.ObjectId().toString();
const ME = new Types.ObjectId().toString();
const UPLOAD = new Types.ObjectId().toString();
const VICTIM_DOC = new Types.ObjectId();

// --- module mocks ------------------------------------------------------------------------------

/** Every callback the route hands to `after()`; the background job is the thing that spends. */
const scheduled: Array<() => unknown> = [];

vi.mock("next/server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, after: (fn: () => unknown) => void scheduled.push(fn) };
});

const connectMongo = vi.fn(async () => undefined);
const resolveActor = vi.fn();
const applyTempUserHeaders = vi.fn((res: unknown) => res);
const forbidUnlessOrgRole = vi.fn(async () => null);
const forbidWaitlisted = vi.fn(async () => null);

const uploadExists = vi.fn(async (_filter: Record<string, any>) => null as unknown);
const uploadFindOne = vi.fn(async (_filter: Record<string, any>) => null as unknown);
const uploadFindOneAndUpdate = vi.fn(async (..._a: unknown[]) => null as unknown);
type LeanOrg = { orgId?: Types.ObjectId } | null;
const docFindById = vi.fn((..._a: unknown[]) => ({ select: () => ({ lean: async (): Promise<LeanOrg> => null }) }));

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/gating/actor", () => ({ resolveActor, applyTempUserHeaders }));
vi.mock("@/lib/orgs/requireOrgEditor", () => ({ forbidUnlessOrgRole }));
vi.mock("@/lib/gating/waitlist", () => ({ forbidWaitlisted }));
vi.mock("@/lib/models/Upload", () => ({
  UploadModel: {
    exists: (...a: any[]) => (uploadExists as any)(...a),
    findOne: (...a: any[]) => (uploadFindOne as any)(...a),
    findOneAndUpdate: (...a: any[]) => (uploadFindOneAndUpdate as any)(...a),
    findByIdAndUpdate: vi.fn(async () => ({})),
    updateOne: vi.fn(async () => ({})),
  },
}));
vi.mock("@/lib/models/Doc", () => ({
  DocModel: {
    findById: (...a: any[]) => (docFindById as any)(...a),
    findOne: vi.fn(() => ({ select: () => ({ lean: async () => null }) })),
    findByIdAndUpdate: vi.fn(async () => ({})),
    updateOne: vi.fn(async () => ({})),
  },
}));
vi.mock("@/lib/models/Org", () => ({ ensurePersonalOrgForUserId: vi.fn(async () => ({ orgId: PERSONAL_ORG })) }));
vi.mock("@/lib/models/Project", () => ({ ProjectModel: { find: vi.fn(async () => []) } }));
vi.mock("@/lib/models/Review", () => ({ ReviewModel: { create: vi.fn(async () => ({})) } }));
vi.mock("@/lib/models/DocChange", () => ({ DocChangeModel: { create: vi.fn(async () => ({})), findOne: vi.fn(async () => null) } }));
vi.mock("@/lib/models/OrgMembership", () => ({ OrgMembershipModel: { find: vi.fn(async () => []) } }));
vi.mock("@/lib/notifications/queue", () => ({ enqueueNotification: vi.fn(), notificationDedupeKey: () => "k" }));
vi.mock("@/lib/blob/clientUpload", () => ({
  buildDocExtractedTextPathname: () => "a.txt",
  buildDocPreviewPngPathname: () => "b.png",
  buildDocPageImagePathname: () => "c.png",
  buildDocPageThumbPathname: () => "d.png",
}));
vi.mock("@vercel/blob", () => ({ put: vi.fn(), del: vi.fn() }));
vi.mock("pdf-parse", () => ({ default: vi.fn(async () => ({ text: "" })) }));
vi.mock("@/lib/ai/analyzePdfText", () => ({
  analyzePdfText: vi.fn(),
  isFallbackAnalysis: () => false,
  analysisTelemetry: () => ({}),
}));
vi.mock("@/lib/ai/docChangeDiff", () => ({ normalizeForCompare: (s: string) => s, runDocChangeDiff: vi.fn() }));
vi.mock("@/lib/ai/reviewDocText", () => ({ reviewDocText: vi.fn() }));
vi.mock("@/lib/ai/requestReviewInvestorFocused", () => ({ runRequestReviewInvestorFocused: vi.fn() }));
vi.mock("@/lib/ai/agentSummary", () => ({ agentSummaryToAnalysis: vi.fn(), readStoredAgentSummary: vi.fn(async () => null) }));
vi.mock("@/lib/ai/askFromText", () => ({ findRaiseAmount: vi.fn(), resolveAsk: vi.fn() }));
vi.mock("@/lib/history/changedPages", () => ({
  attachPageContext: vi.fn(),
  extractPdfTextByPage: vi.fn(),
  fetchPdfBytes: vi.fn(),
  loadChangedPages: vi.fn(),
}));
vi.mock("@/lib/history/pageFingerprint", () => ({ computePageFingerprint: vi.fn() }));
vi.mock("@/lib/pdf/renderPage", () => ({ openPdfDocument: vi.fn(), renderPdfPageToPng: vi.fn() }));
vi.mock("@/lib/credits/creditService", () => ({
  reserveCreditsOrThrow: vi.fn(),
  markLedgerCharged: vi.fn(),
  failAndRefundLedger: vi.fn(),
  recordUnbilledRun: vi.fn(),
}));
vi.mock("@/lib/credits/qualityDefaults", () => ({ getDefaultHistoryQualityTier: () => "standard" }));
vi.mock("@/lib/credits/errors", () => ({ isOutOfCreditsError: () => false, OUT_OF_CREDITS_CODE: "out_of_credits" }));
vi.mock("@/lib/credits/schedule", () => ({ creditsForRun: () => 0 }));
vi.mock("@/lib/credits/aiAutomation", () => ({ getAiAutomation: vi.fn(async () => ({})) }));
vi.mock("@/lib/credits/idempotency", () => ({ idempotencyKeyFromRequest: () => null }));
vi.mock("@/lib/credits/snapshot", () => ({ getCreditsSnapshot: vi.fn(async () => ({ blocked: false })) }));
vi.mock("@/lib/uploads/internalProcess", () => ({
  INTERNAL_PROCESS_HEADER: "x-internal-process",
  verifyInternalProcessToken: () => false,
}));
vi.mock("@/lib/uploads/progressWriter", () => ({
  createUploadProgressReporter: () => ({ report: vi.fn(async () => undefined) }),
}));
vi.mock("@/lib/debug", () => ({ debugLog: vi.fn(), debugError: vi.fn() }));
vi.mock("@/lib/activity/log", () => ({ recordActivity: vi.fn(), agentFromRequest: () => null, agentLabel: () => null }));

const { POST: processPOST } = await import("@/app/api/uploads/[uploadId]/process/route");

// --- helpers -----------------------------------------------------------------------------------

/**
 * The caller: an `lnk_` key minted in the team workspace, attributed to a member who once uploaded
 * into the victim workspace. By `userId` alone this is indistinguishable from that person signing
 * in anywhere they have ever uploaded, which was the whole problem.
 */
function keyInTeamWorkspace() {
  return {
    kind: "user",
    userId: ME,
    orgId: TEAM_ORG,
    personalOrgId: PERSONAL_ORG,
    viaApiKey: { keyId: new Types.ObjectId().toString(), scopes: ["docs:write"] },
  };
}
/** The same person in their own personal workspace: pre-workspace rows are theirs. */
function inPersonalWorkspace() {
  return { kind: "user", userId: ME, orgId: PERSONAL_ORG, personalOrgId: PERSONAL_ORG };
}

const ctx = { params: Promise.resolve({ uploadId: UPLOAD }) };

function processRequest() {
  return new Request(`http://localhost:3000/api/uploads/${UPLOAD}/process?forceReview=1`, { method: "POST" });
}

/** An upload row that is past every state check, so only tenancy can stop the run. */
function readyUpload() {
  return { _id: new Types.ObjectId(UPLOAD), docId: VICTIM_DOC, status: "uploaded", version: 2, userId: new Types.ObjectId(ME) };
}

beforeEach(() => {
  vi.clearAllMocks();
  scheduled.length = 0;
  applyTempUserHeaders.mockImplementation((res: unknown) => res);
  forbidUnlessOrgRole.mockResolvedValue(null as never);
  forbidWaitlisted.mockResolvedValue(null as never);
  resolveActor.mockResolvedValue(keyInTeamWorkspace());
  // Default: the filter finds nothing, which is what the victim's upload looks like from here now.
  uploadExists.mockResolvedValue(null as never);
  uploadFindOne.mockResolvedValue(readyUpload() as never);
  uploadFindOneAndUpdate.mockResolvedValue(readyUpload() as never);
  docFindById.mockReturnValue({ select: () => ({ lean: async () => ({ orgId: new Types.ObjectId(VICTIM_ORG) }) }) });
});

// --- 1. the authorization filter -----------------------------------------------------------------

describe("POST /api/uploads/:uploadId/process authorization filter", () => {
  test("the upload lookup names the workspace, not only who uploaded", async () => {
    await processPOST(processRequest(), ctx as never);
    const filter = uploadExists.mock.calls[0]![0] as Record<string, any>;

    // The bug: `{ _id, userId, isDeleted }` and no orgId anywhere. `forbidUnlessOrgRole` does not
    // cover it, because it answers a question about a different workspace.
    expect(String(filter._id)).toBe(UPLOAD);
    expect(String(filter.userId)).toBe(ME);
    expect(filter.isDeleted).toEqual({ $ne: true });
    expect(filter.orgId).toEqual(new Types.ObjectId(TEAM_ORG));
  });

  test("pre-workspace uploads resolve only from the owner's own personal workspace", async () => {
    resolveActor.mockResolvedValue(inPersonalWorkspace());
    await processPOST(processRequest(), ctx as never);
    const filter = uploadExists.mock.calls[0]![0] as Record<string, any>;

    // `docMatch.ts`'s concession: rows carrying no `orgId` belong to a person, so they come back
    // only while that person is in their own workspace, never from a team one.
    expect(filter.$or).toEqual([
      { orgId: new Types.ObjectId(PERSONAL_ORG) },
      { orgId: { $exists: false } },
      { orgId: null },
    ]);
  });

  test("an upload outside the workspace is 404, and no work is claimed or scheduled", async () => {
    uploadExists.mockResolvedValue(null as never);
    const res = await processPOST(processRequest(), ctx as never);

    expect(res.status).toBe(404);
    expect(uploadFindOneAndUpdate).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(0);
  });
});

// --- 2. the workspace that gets the bill ----------------------------------------------------------

describe("POST /api/uploads/:uploadId/process billing workspace", () => {
  test("a document in another workspace is refused before anything is claimed", async () => {
    // Past the upload gate (a legacy row with no `orgId`, or a row the caller does own), but the
    // document, and so the credit pool the job would charge, belongs to someone else.
    uploadExists.mockResolvedValue({ _id: new Types.ObjectId(UPLOAD) } as never);
    docFindById.mockReturnValue({ select: () => ({ lean: async () => ({ orgId: new Types.ObjectId(VICTIM_ORG) }) }) });

    const res = await processPOST(processRequest(), ctx as never);

    expect(res.status).toBe(404);
    // Nothing claimed means the victim's upload is not left sitting in `processing` either.
    expect(uploadFindOneAndUpdate).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(0);
  });

  test("the caller's own workspace still processes", async () => {
    uploadExists.mockResolvedValue({ _id: new Types.ObjectId(UPLOAD) } as never);
    docFindById.mockReturnValue({ select: () => ({ lean: async () => ({ orgId: new Types.ObjectId(TEAM_ORG) }) }) });

    const res = await processPOST(processRequest(), ctx as never);

    expect(res.status).toBe(200);
    expect(scheduled).toHaveLength(1);
  });

  test("a document that predates workspaces is not refused", async () => {
    // No `orgId` on the document: the job falls back to `actor.orgId`, so there is nothing to
    // disagree with and a legacy doc must not become unprocessable.
    resolveActor.mockResolvedValue(inPersonalWorkspace());
    uploadExists.mockResolvedValue({ _id: new Types.ObjectId(UPLOAD) } as never);
    docFindById.mockReturnValue({ select: () => ({ lean: async () => ({}) }) });

    const res = await processPOST(processRequest(), ctx as never);

    expect(res.status).toBe(200);
    expect(scheduled).toHaveLength(1);
  });
});
