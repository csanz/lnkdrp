import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

/**
 * "Write summary" reruns: only the current version, only when its summary was skipped or failed,
 * never twice at once, and the upload is restored when processing could not be started.
 */
const { state, uploadUpdates, trigger } = vi.hoisted(() => ({
  state: {
    upload: null as Record<string, unknown> | null,
    doc: null as Record<string, unknown> | null,
    claimOk: true,
  },
  uploadUpdates: [] as Array<{ filter: unknown; update: unknown }>,
  trigger: vi.fn(async () => true),
}));

const lean = <T,>(v: () => T) => ({ select: () => ({ lean: async () => v() }), lean: async () => v() });

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => {}) }));
vi.mock("@/lib/models/Upload", () => ({
  UploadModel: {
    findOne: vi.fn(() => lean(() => state.upload)),
    findOneAndUpdate: vi.fn((filter: unknown, update: unknown) => {
      uploadUpdates.push({ filter, update });
      return { lean: async () => (state.claimOk ? { _id: "u" } : null) };
    }),
    updateOne: vi.fn(async (filter: unknown, update: unknown) => {
      uploadUpdates.push({ filter, update });
      return {};
    }),
  },
}));
vi.mock("@/lib/models/Doc", () => ({ DocModel: { findOne: vi.fn(() => lean(() => state.doc)) } }));
vi.mock("@/lib/uploads/internalProcess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/uploads/internalProcess")>()),
  triggerUploadProcessing: trigger,
}));

import { queueSummaryRerun } from "@/lib/uploads/summaryRerun";
import { signInternalProcessToken, verifyInternalProcessToken } from "@/lib/uploads/internalProcess";

const uploadId = new Types.ObjectId();
const docId = new Types.ObjectId();
const orgId = new Types.ObjectId();

beforeEach(() => {
  state.upload = { _id: uploadId, docId, status: "completed", ai: { summary: "skipped" }, aiOutput: null, agentSummary: null };
  state.doc = { _id: docId, orgId, currentUploadId: uploadId };
  state.claimOk = true;
  uploadUpdates.length = 0;
  trigger.mockReset();
  trigger.mockResolvedValue(true);
});

const run = () => queueSummaryRerun({ uploadId: String(uploadId), origin: "http://localhost:3001", orgId: String(orgId) });

describe("queueSummaryRerun", () => {
  test("queues a skipped current version and triggers processing", async () => {
    expect(await run()).toEqual({ ok: true });
    expect(uploadUpdates[0]!.update).toMatchObject({ $set: { status: "uploaded", summaryRerun: true }, $inc: { summaryRerunCount: 1 } });
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  test("refuses a version that already has a summary, or an agent-written one", async () => {
    state.upload = { ...state.upload!, ai: { summary: "done" } };
    expect(await run()).toMatchObject({ ok: false, code: "not_skipped" });
    state.upload = { ...state.upload!, ai: { summary: "skipped" }, agentSummary: { summary: "x" } };
    expect(await run()).toMatchObject({ ok: false, code: "not_skipped" });
    expect(trigger).not.toHaveBeenCalled();
  });

  test("refuses an older version and another workspace", async () => {
    state.doc = { ...state.doc!, currentUploadId: new Types.ObjectId() };
    expect(await run()).toMatchObject({ ok: false, code: "not_current" });
    state.doc = { ...state.doc!, currentUploadId: uploadId, orgId: new Types.ObjectId() };
    expect(await run()).toMatchObject({ ok: false, code: "not_found" });
  });

  test("a second click while one is running is refused", async () => {
    state.claimOk = false;
    expect(await run()).toMatchObject({ ok: false, code: "busy" });
    expect(trigger).not.toHaveBeenCalled();
  });

  test("restores the upload when processing could not be started", async () => {
    trigger.mockResolvedValue(false);
    expect(await run()).toMatchObject({ ok: false, code: "trigger_failed" });
    expect(uploadUpdates[1]!.update).toMatchObject({ $set: { status: "completed", summaryRerun: false } });
  });
});

describe("internal processing token", () => {
  test("verifies only for the same upload, within five minutes", () => {
    process.env.NEXTAUTH_SECRET = "test-secret";
    const now = 1_800_000_000_000;
    const token = signInternalProcessToken("abc", now);
    expect(verifyInternalProcessToken("abc", token, now + 1000)).toBe(true);
    expect(verifyInternalProcessToken("other", token, now + 1000)).toBe(false);
    expect(verifyInternalProcessToken("abc", token, now + 6 * 60 * 1000)).toBe(false);
    expect(verifyInternalProcessToken("abc", `${now}.forged`, now)).toBe(false);
    expect(verifyInternalProcessToken("abc", null, now)).toBe(false);
  });
});
