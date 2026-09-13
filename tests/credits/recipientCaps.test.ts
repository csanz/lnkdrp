import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

/**
 * Recipient uploads are free for the recipient and unbilled for the owner, so they are braked:
 * 20 per link per day on every plan, plus 20 per workspace per day on Free.
 */
const { counts, plan } = vi.hoisted(() => ({
  counts: { docs: 0, uploadsForDoc: 0, uploadsForOrg: 0 },
  plan: { value: "free" as "free" | "pro" },
}));

vi.mock("@/lib/models/Doc", () => ({
  DocModel: { countDocuments: vi.fn(async () => counts.docs) },
}));
vi.mock("@/lib/models/Upload", () => ({
  UploadModel: {
    countDocuments: vi.fn(async (q: Record<string, unknown>) => ("docId" in q ? counts.uploadsForDoc : counts.uploadsForOrg)),
  },
}));
vi.mock("@/lib/billing/planLimits", () => ({
  getWorkspacePlan: vi.fn(async () => plan.value),
}));

import {
  checkRecipientUploadCap,
  FREE_RECIPIENT_UPLOADS_PER_WORKSPACE_PER_DAY,
  RECIPIENT_UPLOADS_PER_TOKEN_PER_DAY,
} from "@/lib/uploads/recipientCaps";

const orgId = new Types.ObjectId();
const projectId = new Types.ObjectId();
const docId = new Types.ObjectId();

beforeEach(() => {
  counts.docs = 0;
  counts.uploadsForDoc = 0;
  counts.uploadsForOrg = 0;
  plan.value = "free";
});

describe("checkRecipientUploadCap", () => {
  test("allows a quiet link on a quiet Free workspace", async () => {
    expect(await checkRecipientUploadCap({ orgId, requestProjectId: projectId })).toEqual({ ok: true });
  });

  test("request link: the 21st upload in a day is refused", async () => {
    counts.docs = RECIPIENT_UPLOADS_PER_TOKEN_PER_DAY;
    const out = await checkRecipientUploadCap({ orgId, requestProjectId: projectId });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.scope).toBe("token");
  });

  test("replace link: counts secret uploads of that doc", async () => {
    counts.uploadsForDoc = RECIPIENT_UPLOADS_PER_TOKEN_PER_DAY;
    const out = await checkRecipientUploadCap({ orgId, replaceDocId: docId });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.scope).toBe("token");
  });

  test("Free workspace: the per-workspace cap applies across links", async () => {
    counts.uploadsForOrg = FREE_RECIPIENT_UPLOADS_PER_WORKSPACE_PER_DAY;
    const out = await checkRecipientUploadCap({ orgId, requestProjectId: projectId });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.scope).toBe("workspace");
  });

  test("Pro workspace: no per-workspace cap, per-link cap still applies", async () => {
    plan.value = "pro";
    counts.uploadsForOrg = 500;
    expect(await checkRecipientUploadCap({ orgId, requestProjectId: projectId })).toEqual({ ok: true });
    counts.docs = RECIPIENT_UPLOADS_PER_TOKEN_PER_DAY;
    expect((await checkRecipientUploadCap({ orgId, requestProjectId: projectId })).ok).toBe(false);
  });
});
