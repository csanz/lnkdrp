/**
 * Two bounds on the anonymous half of a link upload — what a recipient may write, and how fast.
 *
 * A request link is deliberately sign-in-free: `POST /api/requests/:token/uploads` asks only for an
 * `x-lnkdrp-botid` string the caller invents, creates a Doc and an Upload in the owner's workspace,
 * and hands back an upload secret. Everything the recipient does afterwards is authorised by that
 * secret alone. So the two questions worth pinning are the ones a stranger holding it could abuse.
 *
 * - **What they may write.** `PATCH /api/uploads/:id` accepted `rawExtractedText` from the secret
 *   branch and copied it onto the row. The processor prefers text already on the row over parsing
 *   the PDF at all, then puts it on the Doc and feeds it to the summariser and the review agent on
 *   the owner's spend — so the owner would read, as the contents of "their" PDF, whatever the
 *   uploader typed, with the real file never opened. Only the owner branch may set that field now,
 *   and it is capped; a recipient's copy is dropped, not rejected, so a body that also carries
 *   `status: "uploaded"` still completes the upload.
 * - **How fast.** The daily cap was `countDocuments(...) >= 20` and nothing else, with the caller's
 *   `create` happening afterwards, on a route with no limiter at all. Every request in a parallel
 *   burst read the same pre-burst count and every one of them passed. The cap now takes an atomic
 *   reservation (`rateLimit`, a single upsert + `$inc`) that concurrency cannot fool, and the route
 *   has a per-IP brake in front of it.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const UPLOAD_ID = new Types.ObjectId();
const DOC_ID = new Types.ObjectId();
const ORG_ID = new Types.ObjectId();
const OWNER_ID = new Types.ObjectId();
const PROJECT_ID = new Types.ObjectId();
const SECRET = "recipient-held-upload-secret";

// --- shared module mocks -----------------------------------------------------------------------

/** Filters/updates handed to Mongo, captured so assertions can read the query that would run. */
const uploadFindOneAndUpdate = vi.fn((_filter: unknown, _update: unknown) => chain(storedUpload()));
const uploadCountDocuments = vi.fn(async (_filter: unknown) => 0);
const uploadCreate = vi.fn(async (_doc: unknown) => ({ _id: new Types.ObjectId() }));
const docCountDocuments = vi.fn(async (_filter: unknown) => 0);
const docCreate = vi.fn(async (_doc: unknown) => ({ _id: DOC_ID }));
const resolveActor = vi.fn();
const getWorkspacePlan = vi.fn(async () => "free" as const);

/**
 * `rateLimit` stand-in with the real thing's shape: one bucket per key, counting every hit even
 * when it refuses. Tests drive it by pre-seeding `rateLimitBuckets` or by calling in a burst.
 */
const rateLimitBuckets = new Map<string, number>();
const rateLimit = vi.fn(async (input: { key: string; limit: number; windowMs: number; now?: number }) => {
  const next = (rateLimitBuckets.get(input.key) ?? 0) + 1;
  rateLimitBuckets.set(input.key, next);
  const ok = next <= input.limit;
  return { ok, remaining: Math.max(0, input.limit - next), retryAfterSec: ok ? 0 : 60 };
});

function chain(value: unknown): any {
  return { select: () => chain(value), lean: async () => value, catch: undefined };
}

function storedUpload() {
  return {
    _id: UPLOAD_ID,
    docId: DOC_ID,
    orgId: ORG_ID,
    userId: OWNER_ID,
    uploadSecret: SECRET,
    contentType: "application/pdf",
    originalFileName: "deck.pdf",
    status: "uploaded",
  };
}

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/debug", () => ({ debugLog: vi.fn(), debugError: vi.fn() }));
vi.mock("@/lib/activity/log", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/http/rateLimit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/http/rateLimit")>();
  return { ...actual, rateLimit: (...a: unknown[]) => (rateLimit as any)(...a) };
});
vi.mock("@/lib/gating/actor", () => ({
  resolveActor: (...a: unknown[]) => (resolveActor as any)(...a),
  tryResolveUserActor: vi.fn(async () => null),
  applyTempUserHeaders: (res: unknown) => res,
}));
vi.mock("@/lib/billing/planLimits", () => ({
  getWorkspacePlan: (...a: unknown[]) => (getWorkspacePlan as any)(...a),
}));
vi.mock("@/lib/models/Upload", () => ({
  UploadModel: {
    findOne: () => chain(storedUpload()),
    findOneAndUpdate: (...a: unknown[]) => (uploadFindOneAndUpdate as any)(...a),
    countDocuments: (...a: unknown[]) => (uploadCountDocuments as any)(...a),
    create: (...a: unknown[]) => (uploadCreate as any)(...a),
  },
}));
vi.mock("@/lib/models/Doc", () => ({
  DocModel: {
    findOne: () => chain({ _id: DOC_ID, status: "preparing", orgId: ORG_ID }),
    findById: () => chain({ _id: DOC_ID, orgId: ORG_ID, title: "Deck" }),
    findByIdAndUpdate: vi.fn(async () => null),
    countDocuments: (...a: unknown[]) => (docCountDocuments as any)(...a),
    create: (...a: unknown[]) => (docCreate as any)(...a),
  },
}));
vi.mock("@/lib/models/Project", () => ({
  ProjectModel: {
    findOne: () =>
      chain({ _id: PROJECT_ID, orgId: ORG_ID, userId: OWNER_ID, name: "Pitches", isRequest: true }),
    updateOne: vi.fn(async () => ({ modifiedCount: 0 })),
  },
}));
vi.mock("@/lib/models/Org", () => ({
  ensurePersonalOrgForUserId: vi.fn(async () => ({ orgId: ORG_ID })),
}));

const owner = {
  kind: "user",
  userId: OWNER_ID.toString(),
  orgId: ORG_ID.toString(),
  personalOrgId: ORG_ID.toString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  rateLimitBuckets.clear();
  resolveActor.mockResolvedValue(owner as never);
  getWorkspacePlan.mockResolvedValue("free" as never);
  uploadCountDocuments.mockResolvedValue(0 as never);
  docCountDocuments.mockResolvedValue(0 as never);
  uploadFindOneAndUpdate.mockImplementation(() => chain(storedUpload()));
  docCreate.mockResolvedValue({ _id: DOC_ID } as never);
  uploadCreate.mockResolvedValue({ _id: new Types.ObjectId() } as never);
});

/** The `$set` object the handler actually sent to Mongo on the one write it performed. */
function writtenUpdate(): Record<string, unknown> {
  expect(uploadFindOneAndUpdate).toHaveBeenCalledTimes(1);
  return uploadFindOneAndUpdate.mock.calls[0]?.[1] as Record<string, unknown>;
}

function patch(headers: Record<string, string>, body: unknown) {
  return new Request(`http://localhost/api/uploads/${UPLOAD_ID.toString()}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/uploads/:id — who may write the document's text", () => {
  test("a recipient's rawExtractedText never reaches the row", async () => {
    const { PATCH } = await import("@/app/api/uploads/[uploadId]/route");

    const res = await PATCH(
      patch({ "x-upload-secret": SECRET }, {
        status: "uploaded",
        rawExtractedText: "Series A. $40M ARR. Signed by the CFO.",
        metadata: { size: 1024 },
      }),
      { params: Promise.resolve({ uploadId: UPLOAD_ID.toString() }) },
    );

    const update = writtenUpdate();
    expect(update).not.toHaveProperty("rawExtractedText");
    expect(update).not.toHaveProperty("pdfText");
    // Degrade, not refuse: the same body finalises the upload, so the rest of it still applies.
    expect(res.status).toBe(200);
    expect(update.status).toBe("uploaded");
    expect(update.metadata).toEqual({ size: 1024 });
  });

  test("the owner may still set it", async () => {
    const { PATCH } = await import("@/app/api/uploads/[uploadId]/route");

    await PATCH(
      patch({}, { status: "uploaded", rawExtractedText: "text the owner's own client parsed" }),
      { params: Promise.resolve({ uploadId: UPLOAD_ID.toString() }) },
    );

    const update = writtenUpdate();
    expect(update.rawExtractedText).toBe("text the owner's own client parsed");
    expect(update.pdfText).toBe("text the owner's own client parsed");
  });

  test("the owner's text is capped rather than stored whole", async () => {
    const { PATCH } = await import("@/app/api/uploads/[uploadId]/route");

    await PATCH(
      patch({}, { status: "uploaded", rawExtractedText: "x".repeat(3_000_000) }),
      { params: Promise.resolve({ uploadId: UPLOAD_ID.toString() }) },
    );

    expect(String(writtenUpdate().rawExtractedText).length).toBe(1_000_000);
  });
});

describe("checkRecipientUploadCap — the daily brake holds under concurrency", () => {
  test("a burst that all reads the same pre-burst count is still cut off", async () => {
    const { checkRecipientUploadCap, RECIPIENT_UPLOADS_PER_TOKEN_PER_DAY } = await import(
      "@/lib/uploads/recipientCaps"
    );
    // Every caller in the burst sees zero documents — the exact condition under which the old
    // count-then-create check let all of them through.
    docCountDocuments.mockResolvedValue(0 as never);
    getWorkspacePlan.mockResolvedValue("pro" as never);

    const results = await Promise.all(
      Array.from({ length: 200 }, () =>
        checkRecipientUploadCap({ orgId: ORG_ID, requestProjectId: PROJECT_ID }),
      ),
    );

    const allowed = results.filter((r) => r.ok).length;
    expect(allowed).toBeLessThan(200);
    // Bounded by the reservation, not by whatever concurrency the caller could open.
    expect(allowed).toBeLessThanOrEqual(RECIPIENT_UPLOADS_PER_TOKEN_PER_DAY * 2);
    const refused = results.find((r) => !r.ok) as { scope: string };
    expect(refused.scope).toBe("token");
  });

  test("the reservation is per link and lasts a day", async () => {
    const { checkRecipientUploadCap } = await import("@/lib/uploads/recipientCaps");
    getWorkspacePlan.mockResolvedValue("pro" as never);

    await checkRecipientUploadCap({ orgId: ORG_ID, requestProjectId: PROJECT_ID });

    const call = rateLimit.mock.calls[0]?.[0] as { key: string; windowMs: number };
    expect(call.key).toBe(`recipient-upload:token:${PROJECT_ID.toString()}`);
    expect(call.windowMs).toBe(24 * 60 * 60 * 1000);
  });

  test("a Free workspace's own allowance is reserved too", async () => {
    const { checkRecipientUploadCap, FREE_RECIPIENT_UPLOADS_PER_WORKSPACE_PER_DAY } = await import(
      "@/lib/uploads/recipientCaps"
    );
    // Workspace bucket already spent (twice the cap, the reservation's ceiling); the count is
    // clean, so only the atomic reservation can refuse this one.
    rateLimitBuckets.set(`recipient-upload:org:${ORG_ID.toString()}`, FREE_RECIPIENT_UPLOADS_PER_WORKSPACE_PER_DAY * 2);
    uploadCountDocuments.mockResolvedValue(0 as never);

    const result = await checkRecipientUploadCap({ orgId: ORG_ID, requestProjectId: PROJECT_ID });

    expect(result.ok).toBe(false);
    expect((result as { scope: string }).scope).toBe("workspace");
  });
});

describe("POST /api/requests/:token/uploads — the public route has a brake of its own", () => {
  test("a flood from one connection is refused before anything is created", async () => {
    const { POST } = await import("@/app/api/requests/[token]/uploads/route");

    const fire = () =>
      POST(
        new Request("http://localhost/api/requests/tok/uploads", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": "203.0.113.9",
            "x-lnkdrp-botid": "bot-abcdefgh",
          },
          body: JSON.stringify({ originalFileName: "deck.pdf" }),
        }),
        { params: Promise.resolve({ token: "tok" }) },
      );

    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) statuses.push((await fire()).status);

    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    // The refusals cost the owner nothing: no Doc, no Upload, no AI run behind them.
    expect(docCreate.mock.calls.length).toBeLessThan(40);
    expect(rateLimitBuckets.get("recipient-upload:ip:203.0.113.9")).toBe(40);
  });
});
