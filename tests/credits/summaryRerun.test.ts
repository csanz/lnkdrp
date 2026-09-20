import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

/**
 * "Write summary" reruns: only the current version, only when its summary was skipped or failed,
 * never twice at once, and the upload is restored when processing could not be started.
 */
const { state, uploadUpdates, docFilters, trigger } = vi.hoisted(() => ({
  docFilters: [] as unknown[],
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
vi.mock("@/lib/models/Doc", () => ({
  DocModel: {
    findOne: vi.fn((filter: unknown) => {
      docFilters.push(filter);
      // The mock honours the workspace bound, because that is where the rule now lives. It used to
      // be a comparison the caller made after fetching the row unscoped, so a mock that ignored the
      // filter still exercised it; it no longer does.
      return lean(() => {
        const want = (filter as { orgId?: unknown } | null)?.orgId;
        const have = (state.doc as { orgId?: unknown } | null)?.orgId;
        if (want && String(want) !== String(have ?? "")) return null;
        return state.doc;
      });
    }),
  },
}));
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
  docFilters.length = 0;
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

/**
 * The tenancy check used to read `if (params.orgId && doc.orgId && ...)`, and the middle conjunct
 * was a hole you could drive a workspace through: a document with no `orgId` — every document that
 * predates workspaces, and `Doc.orgId` defaults to null — skipped the comparison entirely. Any
 * signed-in member of any workspace could name someone else's legacy upload and have its summary
 * rewritten, with the credit billed to the victim (processing resolves the billing workspace from
 * the upload's owner) and `aiOutput` cleared before the run even starts.
 *
 * The fix is not a better comparison, it is asking the rule that already exists. What is pinned
 * here is that the question reaches the database as part of the query rather than being decided
 * afterwards on a row that was fetched unscoped.
 */
describe("queueSummaryRerun: whose document is it", () => {
  test("the workspace is part of the lookup, not a check after the fact", async () => {
    await run();

    expect(docFilters).toHaveLength(1);
    const filter = docFilters[0] as Record<string, unknown>;
    expect(String((filter as { orgId?: unknown }).orgId)).toBe(String(orgId));
    expect(filter).toHaveProperty("isDeleted", { $ne: true });
  });

  test("without a caller identity there is no legacy branch to fall through", async () => {
    // `allowLegacyByUserId` needs userId *and* a personalOrgId equal to the active org. A caller
    // that cannot answer "whose own workspace is this" gets the strict filter, so an org-less
    // document simply does not resolve — refused rather than waved through.
    await queueSummaryRerun({ uploadId: String(uploadId), origin: "http://localhost:3001", orgId: String(orgId) });

    const filter = docFilters[0] as Record<string, unknown>;
    expect(filter).not.toHaveProperty("$or");
    expect(JSON.stringify(filter)).not.toContain("userId");
  });

  test("the owner's own legacy document still resolves from their own workspace", async () => {
    const userId = new Types.ObjectId();
    await queueSummaryRerun({
      uploadId: String(uploadId),
      origin: "http://localhost:3001",
      orgId: String(orgId),
      userId: String(userId),
      personalOrgId: String(orgId),
    });

    const filter = docFilters[0] as Record<string, unknown>;
    // The legacy arm is present, and `isDeleted` sits beside the `$or` rather than inside one arm.
    expect(filter).toHaveProperty("isDeleted", { $ne: true });
    expect(JSON.stringify(filter)).toContain(String(userId));
  });

  test("a teammate's workspace is not the owner's own, so the legacy branch stays shut", async () => {
    const userId = new Types.ObjectId();
    const teamOrg = new Types.ObjectId();
    await queueSummaryRerun({
      uploadId: String(uploadId),
      origin: "http://localhost:3001",
      orgId: String(teamOrg),
      userId: String(userId),
      personalOrgId: String(orgId),
    });

    const filter = docFilters[0] as Record<string, unknown>;
    expect(String((filter as { orgId?: unknown }).orgId)).toBe(String(teamOrg));
    expect(filter).not.toHaveProperty("$or");
  });
});
