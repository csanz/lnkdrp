/**
 * The cross-tenant **write** that outlived the fix to the GET sitting thirty lines above it.
 *
 * `GET /api/uploads/:uploadId` picked up a workspace bound when the listing beside it did, under a
 * comment naming the two callers it stops: an `lnk_` key, attributed to the member who minted it
 * but scoped to *its own* workspace, and a removed member's session, which falls back to their
 * personal workspace. `PATCH` in the same file kept the pre-workspace rule — `{ _id, userId,
 * isDeleted }` in both the pre-read and the `findOneAndUpdate` — so the sentence describing the
 * gap was sitting immediately above a handler that still had it.
 *
 * PATCH is the worse half. `buildPatchUpdate(..., "owner")` is the only caller allowed to set
 * `rawExtractedText`, and the processor skips `pdfParse` entirely when a value is already on the
 * row: it copies that text onto the Doc and feeds it to the summariser and the review agent on the
 * workspace's credits. So the write is not "edit someone's metadata" — it is choosing what the
 * owner, and the models they pay for, will read as the contents of their own PDF, with the real
 * file never opened. The same route makes that exact argument one function up, about the narrower
 * upload-secret case.
 *
 * Pinned on the **filters the route issues**, because that is where the rule lives, and separately
 * on the write filter, because a route that authorises the update by "the pre-read found a row"
 * has the check in the wrong place.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const TEAM_ORG = new Types.ObjectId();
const PERSONAL_ORG = new Types.ObjectId();
const ME = new Types.ObjectId();
const UPLOAD = new Types.ObjectId();
const VICTIM_DOC = new Types.ObjectId();

// --- module mocks ------------------------------------------------------------------------------

const uploadFindOne = vi.fn((_filter: Record<string, any>) => chain(null as unknown));
const uploadFindOneAndUpdate = vi.fn((_filter: Record<string, any>, _update: unknown) =>
  chain(null as unknown),
);
const resolveActor = vi.fn();
const recordActivity = vi.fn();

function chain(value: unknown): any {
  return { select: () => chain(value), lean: async () => value };
}

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/debug", () => ({ debugLog: vi.fn(), debugError: vi.fn() }));
vi.mock("@/lib/activity/log", () => ({ recordActivity: (...a: unknown[]) => (recordActivity as any)(...a) }));
vi.mock("@/lib/gating/actor", () => ({
  resolveActor: (...a: unknown[]) => (resolveActor as any)(...a),
  applyTempUserHeaders: (res: unknown) => res,
}));
vi.mock("@/lib/models/Upload", () => ({
  UploadModel: {
    findOne: (...a: any[]) => (uploadFindOne as any)(...a),
    findOneAndUpdate: (...a: any[]) => (uploadFindOneAndUpdate as any)(...a),
  },
}));
vi.mock("@/lib/models/Doc", () => ({
  DocModel: {
    findOne: () => chain({ _id: VICTIM_DOC, status: "preparing", orgId: TEAM_ORG }),
    findById: () => chain({ _id: VICTIM_DOC, orgId: TEAM_ORG, title: "Series A" }),
  },
}));

const { GET, PATCH } = await import("@/app/api/uploads/[uploadId]/route");

// --- helpers -----------------------------------------------------------------------------------

/**
 * The attacker's actor: the person did upload this file, into the team workspace, but is acting
 * from somewhere else now — a removed member back in their personal workspace, or an `lnk_` key
 * minted elsewhere. By `userId` alone this is indistinguishable from the owner.
 */
function actorOutsideTheUploadsWorkspace() {
  return {
    kind: "user",
    userId: ME.toString(),
    orgId: PERSONAL_ORG.toString(),
    personalOrgId: PERSONAL_ORG.toString(),
  };
}

/** The same person acting inside the workspace the upload actually belongs to. */
function actorInsideTheWorkspace() {
  return {
    kind: "user",
    userId: ME.toString(),
    orgId: TEAM_ORG.toString(),
    personalOrgId: PERSONAL_ORG.toString(),
  };
}

/** The victim's row, as it sits in Mongo: uploaded by ME, owned by the team workspace. */
function victimUpload() {
  return {
    _id: UPLOAD,
    docId: VICTIM_DOC,
    orgId: TEAM_ORG,
    userId: ME,
    contentType: "application/pdf",
    originalFileName: "series-a.pdf",
    status: "uploaded",
  };
}

const ctx = { params: Promise.resolve({ uploadId: UPLOAD.toString() }) };

function patchRequest(body: unknown) {
  return new Request(`http://localhost/api/uploads/${UPLOAD.toString()}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ATTACK_BODY = { status: "uploaded", rawExtractedText: "Signed by the CFO. $40M ARR." };

beforeEach(() => {
  vi.clearAllMocks();
  resolveActor.mockResolvedValue(actorOutsideTheUploadsWorkspace() as never);
  // What a filter carrying the workspace bound returns for a row in another workspace. The old
  // filter returned the row.
  uploadFindOne.mockImplementation(() => chain(null));
  uploadFindOneAndUpdate.mockImplementation(() => chain(null));
});

// --- the authorization filter -------------------------------------------------------------------

describe("PATCH /api/uploads/:uploadId", () => {
  test("the pre-read names the workspace, not only who uploaded", async () => {
    await PATCH(patchRequest(ATTACK_BODY), ctx);

    const filter = uploadFindOne.mock.calls[0]![0] as Record<string, any>;
    expect(String(filter._id)).toBe(UPLOAD.toString());
    expect(String(filter.userId)).toBe(ME.toString());
    expect(filter.isDeleted).toEqual({ $ne: true });
    // The bug: no `orgId` anywhere in this filter, on the one branch allowed to set the document's
    // text. `$and` rather than a top-level `$or` so a later clause cannot overwrite it.
    expect(filter.$and).toEqual([
      { $or: [{ orgId: PERSONAL_ORG }, { orgId: { $exists: false } }, { orgId: null }] },
    ]);
  });

  test("an lnk_ key minted in another workspace is bound to that workspace, legacy rows included", async () => {
    resolveActor.mockResolvedValue(actorInsideTheWorkspace() as never);
    await PATCH(patchRequest(ATTACK_BODY), ctx);

    const filter = uploadFindOne.mock.calls[0]![0] as Record<string, any>;
    // Not in their own personal workspace, so `docMatch.ts`'s concession for pre-workspace rows
    // does not apply: only rows stamped with this workspace resolve.
    expect(filter.$and).toEqual([{ orgId: TEAM_ORG }]);
  });

  test("an upload outside the workspace is 404 and nothing is written", async () => {
    const res = await PATCH(patchRequest(ATTACK_BODY), ctx);

    expect(res.status).toBe(404);
    expect(uploadFindOneAndUpdate).not.toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();
  });

  test("the write carries the bound itself, not merely the pre-read's blessing", async () => {
    // The caller is legitimately in the workspace, so the handler reaches the update. The filter it
    // sends must still say so: authorising a write by "the earlier lookup found something" leaves
    // the rule in a different query than the one that changes the row.
    resolveActor.mockResolvedValue(actorInsideTheWorkspace() as never);
    uploadFindOne.mockImplementation(() => chain(victimUpload()));
    uploadFindOneAndUpdate.mockImplementation(() => chain(victimUpload()));

    await PATCH(patchRequest(ATTACK_BODY), ctx);

    expect(uploadFindOneAndUpdate).toHaveBeenCalledTimes(1);
    const filter = uploadFindOneAndUpdate.mock.calls[0]![0] as Record<string, any>;
    expect(filter.$and).toEqual([{ orgId: TEAM_ORG }]);
    // And the write it was gating is the one that matters: the document's text.
    const update = uploadFindOneAndUpdate.mock.calls[0]![1] as Record<string, unknown>;
    expect(update.rawExtractedText).toBe(ATTACK_BODY.rawExtractedText);
  });
});

// --- the read side, so the two cannot drift apart again -------------------------------------------

describe("GET /api/uploads/:uploadId", () => {
  test("still carries the same bound the PATCH beside it now uses", async () => {
    await GET(new Request(`http://localhost/api/uploads/${UPLOAD.toString()}`), ctx);

    const filter = uploadFindOne.mock.calls[0]![0] as Record<string, any>;
    expect(filter.$and).toEqual([
      { $or: [{ orgId: PERSONAL_ORG }, { orgId: { $exists: false } }, { orgId: null }] },
    ]);
  });
});
