/**
 * `restoreDocToLastGood`: a failed upload hands the document back to its last good version, and
 * only while the document still points at the failed upload (code review 2026-09-23, M5).
 */
import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  uploadFindOne: vi.fn(),
  docUpdateOne: vi.fn(),
}));

vi.mock("@/lib/debug", () => ({ debugLog: () => undefined }));
vi.mock("@/lib/models/Upload", () => ({
  UploadModel: {
    findOne: (filter: unknown) => ({
      sort: () => ({ select: () => ({ lean: () => mocks.uploadFindOne(filter) }) }),
    }),
  },
}));
vi.mock("@/lib/models/Doc", () => ({ DocModel: { updateOne: mocks.docUpdateOne } }));

import { restoreDocToLastGood } from "@/lib/uploads/restoreDocAfterFailure";

const DOC = new Types.ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa");
const FAILED = new Types.ObjectId("bbbbbbbbbbbbbbbbbbbbbbbb");
const GOOD = new Types.ObjectId("cccccccccccccccccccccccc");

describe("restoreDocToLastGood", () => {
  beforeEach(() => {
    mocks.uploadFindOne.mockReset();
    mocks.docUpdateOne.mockReset();
    mocks.docUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  });

  it("points the document at the newest completed upload other than the failed one", async () => {
    mocks.uploadFindOne.mockResolvedValue({ _id: GOOD, blobUrl: "https://blob/v2.pdf", previewImageUrl: "https://blob/p.png" });
    const out = await restoreDocToLastGood({ docId: DOC, failedUploadId: FAILED });

    const [filter] = (mocks.uploadFindOne.mock.calls as unknown[][])[0] as [Record<string, unknown>];
    expect(filter).toMatchObject({ docId: DOC, _id: { $ne: FAILED }, status: "completed" });

    const [docFilter, update] = (mocks.docUpdateOne.mock.calls as unknown[][])[0] as [Record<string, unknown>, { $set: Record<string, unknown> }];
    // Only while this failed upload is still current: a newer upload must not be clobbered.
    expect(docFilter).toEqual({ _id: DOC, currentUploadId: FAILED });
    expect(update.$set).toEqual({
      status: "ready",
      currentUploadId: GOOD,
      uploadId: GOOD,
      blobUrl: "https://blob/v2.pdf",
      previewImageUrl: "https://blob/p.png",
      firstPagePngUrl: "https://blob/p.png",
    });
    expect(out).toEqual({ restoredTo: String(GOOD), status: "ready", docUpdated: true });
  });

  it("fails the document when it never had a completed version, or drafts it when asked", async () => {
    mocks.uploadFindOne.mockResolvedValue(null);
    const failed = await restoreDocToLastGood({ docId: DOC, failedUploadId: FAILED });
    expect(failed.status).toBe("failed");
    expect(((mocks.docUpdateOne.mock.calls as unknown[][])[0] as [unknown, { $set: Record<string, unknown> }])[1].$set).toEqual({ status: "failed" });

    const drafted = await restoreDocToLastGood({ docId: DOC, failedUploadId: FAILED, noVersionStatus: "draft" });
    expect(drafted.status).toBe("draft");
  });

  it("reports docUpdated false when a newer upload already took over", async () => {
    mocks.uploadFindOne.mockResolvedValue({ _id: GOOD });
    mocks.docUpdateOne.mockResolvedValue({ modifiedCount: 0 });
    const out = await restoreDocToLastGood({ docId: DOC, failedUploadId: FAILED });
    expect(out.docUpdated).toBe(false);
  });
});
