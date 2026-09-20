/**
 * Two routes that each disagreed with the rest of the product, in opposite directions.
 *
 * - **`POST /api/docs/:id/share-password` acted on documents in the trash.** It built its own copy
 *   of the "which document may this actor act on" filter and left out `isDeleted` entirely — the
 *   GET half of the same file had it. So a deleted document could be given a share password, or
 *   have one cleared, and because the write goes through to the default link
 *   (`writePasswordToDefaultLink`), clearing it *re-armed* the link of a document the owner
 *   believed was gone. Both halves now call `buildDocMatch`.
 *
 * - **`GET /api/download/:token/pdf` counted the owner as a recipient.** Every other ingest — the
 *   public PDF route and the stats route — flags an owner-side viewer with `isOwnerPreview` so the
 *   row is recorded but never counted. This one never read the session's relationship to the
 *   document at all, so the `ShareView` row it upserts carried no `isOwnerPreview` field, and
 *   absent reads as "recipient" to every downstream `{ $ne: true }`. It is keyed on the *approved
 *   person* rather than a browser botId, so unlike a botId row nothing later ever corrects it: a
 *   teammate approving their own download request inflated the document's download figures
 *   permanently.
 *
 * Both are pinned as filters-issued assertions, in the style of tests/lib/crossTenantScoping.test.ts
 * — the rule lives in the query and in what is written, not in the response body.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const ORG = new Types.ObjectId();
const ME = new Types.ObjectId();
const DOC = new Types.ObjectId();

// --- shared module mocks -----------------------------------------------------------------------

const connectMongo = vi.fn(async () => undefined);
const resolveActor = vi.fn(async () => ({ kind: "user", userId: ME.toString(), orgId: ORG.toString(), personalOrgId: ORG.toString() }));
const tryResolveUserActorFastWithPersonalOrg = vi.fn(async () => null);
const applyTempUserHeaders = vi.fn((res: unknown) => res);

const docFindOneAndUpdate = vi.fn((_filter: Record<string, any>, ..._rest: unknown[]) => ({
  lean: async () => null,
}));
const docFindOne = vi.fn((_filter: Record<string, any>) => ({
  select: () => ({ lean: async () => ({ _id: DOC, orgId: ORG, userId: ME, blobUrl: "https://blob.test/x.pdf", title: "Deck", fileName: "deck.pdf" }) }),
}));
const shareViewUpdateOne = vi.fn(async (..._a: unknown[]) => ({ upsertedCount: 1 }));
const touchShareLink = vi.fn(async () => undefined);
const recordActivity = vi.fn(async () => undefined);
const isOwnerSideViewer = vi.fn(async () => true);

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/gating/actor", () => ({
  resolveActor,
  applyTempUserHeaders,
  tryResolveUserActorFastWithPersonalOrg,
}));
vi.mock("@/lib/models/Doc", () => ({
  DocModel: {
    findOneAndUpdate: (...a: any[]) => (docFindOneAndUpdate as any)(...a),
    findOne: (...a: any[]) => (docFindOne as any)(...a),
    updateOne: vi.fn(async () => ({ matchedCount: 1 })),
  },
}));
vi.mock("@/lib/models/ShareView", () => ({
  ShareViewModel: { updateOne: (...a: any[]) => (shareViewUpdateOne as any)(...a) },
}));
vi.mock("@/lib/models/ShareDownloadRequest", () => ({
  ShareDownloadRequestModel: {
    findOne: () => ({ select: () => ({ lean: async () => ({ requesterEmail: "me@example.com", docId: DOC, shareId: "abc123" }) }) }),
  },
}));
vi.mock("@/lib/models/User", () => ({
  UserModel: { findOne: () => ({ select: () => ({ lean: async () => ({ email: "me@example.com" }) }) }) },
}));
vi.mock("@/lib/share/links", () => ({
  resolveShareLink: vi.fn(async () => ({ refusal: null, link: { _id: new Types.ObjectId(), shareId: "abc123", label: null, isDefault: true } })),
  shareLinkUnlocked: vi.fn(() => true),
  touchShareLink: (...a: any[]) => (touchShareLink as any)(...a),
  ensureDefaultLink: vi.fn(async () => ({ _id: new Types.ObjectId(), orgId: ORG })),
  updateShareLink: vi.fn(async () => undefined),
}));
vi.mock("@/lib/activity/log", () => ({ recordActivity: (...a: any[]) => (recordActivity as any)(...a) }));
vi.mock("@/lib/share/ownerSide", () => ({ isOwnerSideViewer: (...a: any[]) => (isOwnerSideViewer as any)(...a) }));
vi.mock("@/lib/orgs/requireOrgEditor", () => ({ forbidUnlessOrgRole: vi.fn(async () => null) }));
vi.mock("@/lib/errors/logger", () => ({ logErrorEvent: vi.fn(), ERROR_CODE_UNHANDLED_EXCEPTION: "unhandled" }));
vi.mock("@/lib/debug", () => ({ debugError: vi.fn() }));

/** Let the route's fire-and-forget analytics write land. */
async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveActor.mockResolvedValue({ kind: "user", userId: ME.toString(), orgId: ORG.toString(), personalOrgId: ORG.toString() } as never);
  isOwnerSideViewer.mockResolvedValue(true as never);
  shareViewUpdateOne.mockResolvedValue({ upsertedCount: 1 } as never);
});

// --- share password on a deleted document --------------------------------------------------------

describe("POST /api/docs/:docId/share-password", () => {
  test("the write is bounded by deletion, so a document in the trash is not found", async () => {
    const { POST } = await import("@/app/api/docs/[docId]/share-password/route");

    await POST(
      new Request("http://localhost/api/docs/x/share-password", { method: "POST", body: JSON.stringify({ password: "hunter2" }) }),
      { params: Promise.resolve({ docId: DOC.toString() }) },
    );

    expect(docFindOneAndUpdate).toHaveBeenCalled();
    const filter = docFindOneAndUpdate.mock.calls[0]?.[0] as Record<string, unknown>;
    // The bug was the *absence* of this key, not a wrong value in it.
    expect(filter).toHaveProperty("isDeleted", { $ne: true });
  });

  test("a team workspace is still bounded by workspace, not only by deletion", async () => {
    // The first two cases run with orgId === personalOrgId, which exercises only the legacy branch
    // of `buildDocMatch`. Without this one a helper that returned `{ isDeleted: { $ne: true } }` and
    // dropped the tenancy would pass — and make the route cross-tenant.
    const teamOrg = new Types.ObjectId();
    resolveActor.mockResolvedValue({
      kind: "user",
      userId: ME.toString(),
      orgId: teamOrg.toString(),
      personalOrgId: ORG.toString(),
    } as never);
    const { POST } = await import("@/app/api/docs/[docId]/share-password/route");

    await POST(
      new Request("http://localhost/api/docs/x/share-password", { method: "POST", body: JSON.stringify({ password: "hunter2" }) }),
      { params: Promise.resolve({ docId: DOC.toString() }) },
    );

    const filter = docFindOneAndUpdate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(filter).toHaveProperty("isDeleted", { $ne: true });
    expect(String((filter as { orgId?: unknown }).orgId)).toBe(teamOrg.toString());
    expect(String((filter as { _id?: unknown })._id)).toBe(DOC.toString());
    // No by-userId alternative from a team workspace.
    expect(filter).not.toHaveProperty("$or");
  });

  test("clearing a password is bounded the same way — it is the half that re-armed the link", async () => {
    const { POST } = await import("@/app/api/docs/[docId]/share-password/route");

    await POST(
      new Request("http://localhost/api/docs/x/share-password", { method: "POST", body: JSON.stringify({ password: null }) }),
      { params: Promise.resolve({ docId: DOC.toString() }) },
    );

    const filter = docFindOneAndUpdate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(filter).toHaveProperty("isDeleted", { $ne: true });
  });
});

// --- owner-side downloads through an approved claim ----------------------------------------------

describe("GET /api/download/:token/pdf", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { "content-length": "4" } })),
    );
  });

  test("an owner-side download is recorded, flagged, and not counted", async () => {
    isOwnerSideViewer.mockResolvedValue(true as never);
    const { GET } = await import("@/app/api/download/[token]/pdf/route");

    await GET(new Request("http://localhost/api/download/t/pdf"), { params: Promise.resolve({ token: "t" }) });
    await settle();

    expect(shareViewUpdateOne).toHaveBeenCalled();
    const update = shareViewUpdateOne.mock.calls[0]?.[1] as { $set?: Record<string, unknown> };
    // Recorded — the row is still written, because a link the owner cannot open themselves is worth
    // being able to see in the raw rows.
    expect(update.$set).toHaveProperty("isOwnerPreview", true);
    // ...and not counted, on either surface.
    expect(touchShareLink).not.toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();
  });

  test("a real recipient is counted exactly as before", async () => {
    isOwnerSideViewer.mockResolvedValue(false as never);
    const { GET } = await import("@/app/api/download/[token]/pdf/route");

    await GET(new Request("http://localhost/api/download/t/pdf"), { params: Promise.resolve({ token: "t" }) });
    await settle();

    const update = shareViewUpdateOne.mock.calls[0]?.[1] as { $set?: Record<string, unknown> };
    // Written explicitly rather than left absent: an absent field and a false one read the same to
    // `{ $ne: true }` today, and only one of them survives a later change of default.
    expect(update.$set).toHaveProperty("isOwnerPreview", false);
    expect(touchShareLink).toHaveBeenCalledWith("abc123", "download");
    expect(recordActivity).toHaveBeenCalled();
  });
});
