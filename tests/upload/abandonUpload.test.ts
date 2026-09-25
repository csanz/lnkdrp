/**
 * `abandonUpload`: a failed import hands the document back to its last good version, and a
 * document that never had one is removed rather than left as an "Untitled document" in `failed`
 * (code review 2026-09-23, M31, the server half).
 */
import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  uploadFindOne: vi.fn(),
  uploadUpdateOne: vi.fn(async () => ({ modifiedCount: 1 })),
  docUpdateOne: vi.fn(async () => ({ modifiedCount: 1 })),
  restore: vi.fn(),
}));

vi.mock("@/lib/debug", () => ({ debugLog: () => undefined }));
vi.mock("@/lib/mongodb", () => ({ connectMongo: async () => undefined }));
vi.mock("@/lib/models/Upload", () => ({
  UploadModel: {
    findOne: (filter: unknown) => ({ select: () => ({ lean: () => mocks.uploadFindOne(filter) }) }),
    updateOne: mocks.uploadUpdateOne,
  },
}));
vi.mock("@/lib/models/Doc", () => ({ DocModel: { updateOne: mocks.docUpdateOne } }));
vi.mock("@/lib/uploads/progressWriter", () => ({
  createUploadProgressReporter: () => ({ report: async () => undefined }),
}));
vi.mock("@/lib/uploads/restoreDocAfterFailure", () => ({ restoreDocToLastGood: mocks.restore }));

import { abandonUpload } from "@/lib/uploads/abandonUpload";

const DOC = new Types.ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa");
const UPLOAD = new Types.ObjectId("bbbbbbbbbbbbbbbbbbbbbbbb");
const USER = "cccccccccccccccccccccccc";

/** Every DocModel.updateOne call's `$set`, in order. */
function docSets(): Array<Record<string, unknown>> {
  return (mocks.docUpdateOne.mock.calls as unknown[][]).map((c) => (c[1] as { $set?: Record<string, unknown> }).$set ?? {});
}

describe("abandonUpload", () => {
  beforeEach(() => {
    mocks.uploadFindOne.mockReset();
    mocks.uploadUpdateOne.mockClear();
    mocks.docUpdateOne.mockClear();
    mocks.restore.mockReset();
    mocks.uploadFindOne.mockResolvedValue({ _id: UPLOAD, docId: DOC, version: 1 });
  });

  it("soft-deletes a document that never had a completed version", async () => {
    mocks.restore.mockResolvedValue({ restoredTo: null, status: "failed", docUpdated: true });
    await abandonUpload({ uploadId: String(UPLOAD), userId: USER, reason: "404" });

    const del = (mocks.docUpdateOne.mock.calls as unknown[][]).find((c) => (c[1] as { $set?: { isDeleted?: boolean } }).$set?.isDeleted === true);
    expect(del).toBeDefined();
    // Only while this upload is still the document's current one, and never twice.
    expect(del?.[0]).toEqual({ _id: DOC, currentUploadId: UPLOAD, isDeleted: { $ne: true } });
    expect((del?.[1] as { $set: Record<string, unknown> }).$set.deletedDate).toBeInstanceOf(Date);
  });

  it("keeps a document that fell back to an earlier good version", async () => {
    mocks.restore.mockResolvedValue({ restoredTo: "dddddddddddddddddddddddd", status: "ready", docUpdated: true });
    await abandonUpload({ uploadId: String(UPLOAD), userId: USER, reason: "404" });
    expect(docSets().some((s) => s.isDeleted === true)).toBe(false);
  });

  it("leaves the document alone when a newer upload already took over", async () => {
    mocks.restore.mockResolvedValue({ restoredTo: null, status: "failed", docUpdated: false });
    await abandonUpload({ uploadId: String(UPLOAD), userId: USER, reason: "404" });
    expect(docSets().some((s) => s.isDeleted === true)).toBe(false);
  });

  it("does nothing for an upload it cannot find in `uploading`", async () => {
    mocks.uploadFindOne.mockResolvedValue(null);
    await abandonUpload({ uploadId: String(UPLOAD), userId: USER, reason: "404" });
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(mocks.docUpdateOne).not.toHaveBeenCalled();
  });
});
