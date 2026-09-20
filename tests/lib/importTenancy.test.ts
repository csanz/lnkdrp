/**
 * The cross-tenant **write** that survived the fix to `GET /api/uploads`.
 *
 * That listing was scoped by `userId` alone (see tests/lib/crossTenantScoping.test.ts) and got a
 * workspace bound. Its two write siblings in the same directory kept the old rule:
 * `POST /api/uploads/:uploadId/import-url` and `.../import-bytes` both authorised with
 * `{ _id: uploadId, userId: actor.userId }` under a comment claiming the upload had to belong to
 * the actor. The only other gate is `forbidUnlessOrgRole`, which asks about the caller's role in
 * the workspace they are *currently* in, not the upload's — so between them the two gates never
 * asked whether those were the same workspace.
 *
 * An `lnk_` key resolves to the member who minted it but is scoped to its own workspace
 * (`apiKeyActor.ts`), so a key minted in workspace B, held by someone who had also uploaded into
 * workspace A (or who has since been removed from A), passed both checks — and then the route
 * wrote attacker-chosen bytes into A's document as a new version.
 *
 * Pinned the way the sibling is: on the **filter the route issues**, because the rule lives in the
 * query, plus the refusal that follows when the row does not match, because here a miss has to stop
 * a blob write rather than merely shorten a list.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const TEAM_ORG = new Types.ObjectId().toString();
const PERSONAL_ORG = new Types.ObjectId().toString();
const ME = new Types.ObjectId().toString();
const UPLOAD = new Types.ObjectId().toString();
/** A document in the workspace the key was *not* minted in. */
const VICTIM_DOC = new Types.ObjectId();

// --- module mocks ------------------------------------------------------------------------------

const connectMongo = vi.fn(async () => undefined);
const resolveActor = vi.fn();
const applyTempUserHeaders = vi.fn((res: unknown) => res);
const forbidUnlessOrgRole = vi.fn(async () => null);

const uploadFindOne = vi.fn(async (_filter: Record<string, any>) => null as unknown);
const uploadFindByIdAndUpdate = vi.fn(async (..._a: unknown[]) => ({}));
const docFindOne = vi.fn((_filter: Record<string, any>) => ({
  select: () => ({ lean: async () => null }),
}));
const docFindById = vi.fn((..._a: unknown[]) => ({
  select: () => ({ lean: async () => null }),
}));
const put = vi.fn(async () => ({ url: "https://store123.public.blob.vercel-storage.com/x.pdf", pathname: "x.pdf" }));
const safeFetchUrl = vi.fn(async (..._a: unknown[]) => ({
  response: new Response(null, { status: 401 }),
  body: Buffer.alloc(0),
  setCookies: [] as string[],
}));
const abandonUploadIfImportFailed = vi.fn(
  async (_res: Response, _uploadId: string, _actor: unknown) => undefined,
);

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/gating/actor", () => ({ resolveActor, applyTempUserHeaders }));
vi.mock("@/lib/gating/actorRateLimit", () => ({ actorRateLimitResponse: () => null }));
vi.mock("@/lib/orgs/requireOrgEditor", () => ({ forbidUnlessOrgRole }));
vi.mock("@/lib/models/Upload", () => ({
  UploadModel: {
    findOne: (...a: any[]) => (uploadFindOne as any)(...a),
    findByIdAndUpdate: (...a: any[]) => (uploadFindByIdAndUpdate as any)(...a),
  },
}));
vi.mock("@/lib/models/Doc", () => ({
  DocModel: {
    findOne: (...a: any[]) => (docFindOne as any)(...a),
    findById: (...a: any[]) => (docFindById as any)(...a),
  },
}));
vi.mock("@vercel/blob", () => ({ put: (...a: any[]) => (put as any)(...a) }));
vi.mock("@/lib/http/safeFetchUrl", () => ({
  safeFetchUrl: (...a: any[]) => (safeFetchUrl as any)(...a),
  SafeFetchError: class SafeFetchError extends Error {
    code = "UNKNOWN";
  },
}));
vi.mock("@/lib/blob/clientUpload", () => ({ buildDocBlobPathname: () => "docs/x/y.pdf" }));
vi.mock("@/lib/blob/serverClientUploadRoute", () => ({
  looksLikePdfBytes: () => true,
  sanitizeFileName: (n: string) => n,
  PDF_ONLY_ERROR_MESSAGE: "pdf only",
  UNSUPPORTED_FILE_TYPE_CODE: "unsupported_file_type",
}));
vi.mock("@/lib/debug", () => ({ debugLog: vi.fn(), debugError: vi.fn() }));
vi.mock("@/lib/activity/log", () => ({
  recordActivity: vi.fn(),
  agentFromRequest: () => null,
  agentLabel: () => null,
}));
vi.mock("@/lib/uploads/abandonUpload", () => ({ abandonUploadIfImportFailed }));
vi.mock("@/lib/uploads/progressWriter", () => ({
  createUploadProgressReporter: () => ({ report: vi.fn(async () => undefined) }),
}));

const { POST: importUrlPOST } = await import("@/app/api/uploads/[uploadId]/import-url/route");
const { POST: importBytesPOST } = await import("@/app/api/uploads/[uploadId]/import-bytes/route");

// --- helpers -----------------------------------------------------------------------------------

/**
 * The attacker's actor: an `lnk_` key minted in the team workspace, attributed to a member whose
 * *personal* workspace is somewhere else entirely. By `userId` alone this is indistinguishable
 * from that person signing in anywhere they have ever uploaded.
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
/** The same person sitting in their own personal workspace: pre-workspace rows are theirs. */
function inPersonalWorkspace() {
  return { kind: "user", userId: ME, orgId: PERSONAL_ORG, personalOrgId: PERSONAL_ORG };
}

const ctx = { params: Promise.resolve({ uploadId: UPLOAD }) };

function importUrlRequest(url = "https://example.com/deck.pdf") {
  return new Request(`http://localhost:3000/api/uploads/${UPLOAD}/import-url`, {
    method: "POST",
    body: JSON.stringify({ url }),
  });
}

function importBytesRequest() {
  return new Request(`http://localhost:3000/api/uploads/${UPLOAD}/import-bytes`, {
    method: "POST",
    body: JSON.stringify({
      contentBase64: Buffer.from("%PDF-1.4\nattacker bytes\n").toString("base64"),
      fileName: "attacker.pdf",
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  applyTempUserHeaders.mockImplementation((res: unknown) => res);
  forbidUnlessOrgRole.mockResolvedValue(null as never);
  resolveActor.mockResolvedValue(keyInTeamWorkspace());
  // Default: the filter finds nothing — which is what the victim's upload, sitting in another
  // workspace, now looks like from here. The old filter returned it.
  uploadFindOne.mockResolvedValue(null as never);
  docFindOne.mockReturnValue({ select: () => ({ lean: async () => null }) });
  docFindById.mockReturnValue({ select: () => ({ lean: async () => null }) });
});

// --- the authorization filter --------------------------------------------------------------------

describe.each([
  ["import-url", () => importUrlPOST(importUrlRequest(), ctx)],
  ["import-bytes", () => importBytesPOST(importBytesRequest(), ctx)],
])("POST /api/uploads/:uploadId/%s", (_name, call) => {
  test("the upload lookup names the workspace, not only who uploaded", async () => {
    await call();
    const filter = uploadFindOne.mock.calls[0]![0] as Record<string, any>;

    // The bug: `{ _id, userId, isDeleted }` and no orgId anywhere. `forbidUnlessOrgRole` does not
    // cover it — it answers a question about a different workspace.
    expect(String(filter._id)).toBe(UPLOAD);
    expect(String(filter.userId)).toBe(ME);
    expect(filter.isDeleted).toEqual({ $ne: true });
    expect(filter.$and).toEqual([{ orgId: new Types.ObjectId(TEAM_ORG) }]);
  });

  test("pre-workspace uploads resolve only from the owner's own personal workspace", async () => {
    resolveActor.mockResolvedValue(inPersonalWorkspace());
    await call();
    const filter = uploadFindOne.mock.calls[0]![0] as Record<string, any>;

    // The `docMatch.ts` concession: rows that carry no `orgId` belong to a person, so they come
    // back only while that person is in their own workspace — never from a team one.
    expect(filter.$and).toEqual([
      { $or: [{ orgId: new Types.ObjectId(PERSONAL_ORG) }, { orgId: { $exists: false } }, { orgId: null }] },
    ]);
  });

  test("an upload outside the workspace is 404, and nothing is written", async () => {
    // The filter above is what makes this `null`; the route must then stop rather than fall
    // through to the blob write.
    uploadFindOne.mockResolvedValue(null as never);
    const res = await call();

    expect(res.status).toBe(404);
    expect(put).not.toHaveBeenCalled();
    expect(uploadFindByIdAndUpdate).not.toHaveBeenCalled();
    // And the refusal is a *404*, which is the status `abandonUploadIfImportFailed` declines to
    // act on — otherwise this same request would become a way to knock a stranger's document out
    // of `preparing`. The wrapper hands it every non-ok response; the exclusion is inside.
    const handed = abandonUploadIfImportFailed.mock.calls[0]?.[0] as Response | undefined;
    expect(handed?.status).toBe(404);
  });
});

// --- the second way in, on import-url only --------------------------------------------------------

describe("POST /api/uploads/:uploadId/import-url password-protected share fallback", () => {
  test("the owner shortcut for a 401 share is bounded by the workspace too", async () => {
    // Past the upload gate: the caller does own this upload, in this workspace.
    uploadFindOne.mockResolvedValue({
      _id: new Types.ObjectId(UPLOAD),
      docId: VICTIM_DOC,
      orgId: new Types.ObjectId(TEAM_ORG),
      version: 2,
    } as never);
    safeFetchUrl.mockResolvedValue({
      response: new Response(null, { status: 401 }),
      body: Buffer.alloc(0),
      setCookies: [],
    } as never);

    // A share slug the caller names in their own request body — it need not be in their workspace.
    await importUrlPOST(importUrlRequest("/s/VICTIMSLUG1"), ctx);

    const filter = docFindOne.mock.calls[0]![0] as Record<string, any>;
    expect(filter.shareId).toBe("VICTIMSLUG1");
    // Without this, "is the caller the owner?" was decided by `userId` alone, and the server handed
    // back another workspace's private blob URL to fetch and re-publish.
    expect(filter.$and).toEqual([{ orgId: new Types.ObjectId(TEAM_ORG) }]);
  });
});
