/**
 * A request repo hands out two capability links and, until this change, could never take either
 * one back.
 *
 * `/r/:requestUploadToken` ("drop your file here") and `/request-view/:requestViewToken` ("read
 * what was dropped") were minted once, at creation, and no route, MCP tool or admin screen could
 * replace a live one — every other write either created a fresh row or back-filled an empty slot
 * behind an `$exists:false` guard. So a link forwarded out of an email thread was permanent
 * access, and the documented escape hatch — delete the repo — did nothing either, because the
 * public readers matched on the token alone and never looked at `isDeleted`.
 *
 * Two halves, pinned here together because either one alone leaves the owner with no move:
 *
 *  1. **Rotation.** `PATCH /api/projects/:id` accepts `{ rotateRequestTokens: "upload" | "view" |
 *     "both" }` and writes fresh 32-char tokens. Rotation, not revocation: `Project`'s
 *     pre-validate invariant requires a request repo to carry a `requestUploadToken`, and
 *     `GET /api/requests` finds repos by `isRequest` **or** that token, so nulling it would either
 *     invalidate the row or hide the repo from its own owner.
 *  2. **Delete actually deletes.** The two upload-token readers (`/r/:token` and
 *     `POST /api/requests/:token/uploads`) now carry `isDeleted: { $ne: true }`, which the two
 *     view-token readers already had.
 *
 * Written as filter-and-write assertions in the style of tests/lib/crossTenantScoping.test.ts: the
 * rule lives in the query and in what lands on the document, not in the response mapping.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";
import { NextResponse } from "next/server";

const ORG = new Types.ObjectId();
const USER = new Types.ObjectId();
const PROJECT = new Types.ObjectId();

const OLD_UPLOAD_TOKEN = "uploadTokenMintedAtCreation0001";
const OLD_VIEW_TOKEN = "viewTokenMintedAtCreation000001";

// --- shared module mocks -----------------------------------------------------------------------

const connectMongo = vi.fn(async () => undefined);
const applyTempUserHeaders = vi.fn((res: unknown) => res);
const resolveActor = vi.fn(async () => ({
  kind: "user" as const,
  userId: USER.toString(),
  orgId: ORG.toString(),
  personalOrgId: ORG.toString(),
}));
const tryResolveUserActor = vi.fn(async () => null);
const recordActivity = vi.fn();

const projectFindOne = vi.fn(async (_filter: Record<string, any>) => null as any);

/** Deterministic, distinguishable mints so a rotation is visible in an assertion. */
let secretCounter = 0;
const newSecretToken = vi.fn((len = 24) => `freshToken${len}No${++secretCounter}`);

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/gating/actor", () => ({ resolveActor, applyTempUserHeaders, tryResolveUserActor }));
vi.mock("@/lib/models/Project", () => ({
  ProjectModel: {
    findOne: (...a: any[]) => (projectFindOne as any)(...a),
    updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    exists: vi.fn(async () => null),
  },
}));
vi.mock("@/lib/models/Doc", () => ({
  DocModel: {
    findOne: vi.fn(() => ({ select: () => ({ lean: async () => null }) })),
    find: vi.fn(() => ({ sort: () => ({ select: () => ({ lean: async () => [] }) }) })),
    updateMany: vi.fn(async () => ({ matchedCount: 0 })),
    countDocuments: vi.fn(async () => 0),
    create: vi.fn(async () => ({ _id: new Types.ObjectId() })),
  },
  allocateDocUploadVersion: vi.fn(),
}));
vi.mock("@/lib/models/Upload", () => ({ UploadModel: { create: vi.fn(async () => ({ _id: new Types.ObjectId() })) } }));
vi.mock("@/lib/models/Org", () => ({ ensurePersonalOrgForUserId: vi.fn(async () => ORG) }));
vi.mock("@/lib/crypto/randomBase62", () => ({
  newSecretToken: (...a: any[]) => (newSecretToken as any)(...a),
  newShareId: () => "SHAREIDAAAAA",
  randomBase62: (n: number) => "r".repeat(n),
}));
vi.mock("@/lib/orgs/requireOrgRole", () => ({ requireOrgRole: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/activity/log", () => ({
  recordActivity: (...a: any[]) => (recordActivity as any)(...a),
  agentFromRequest: () => null,
  agentLabel: () => null,
}));
vi.mock("@/lib/debug", () => ({ debugLog: vi.fn(), debugError: vi.fn() }));
vi.mock("@/lib/http/errorResponse", () => ({
  authOrRateLimitResponse: () => null,
  errorJson: (err: unknown) =>
    NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 }),
}));
vi.mock("@/lib/share/projectLinks", () => ({ setAllProjectLinksEnabled: vi.fn(async () => undefined) }));
vi.mock("@/lib/tags/service", () => ({ removeAllTagsFromTarget: vi.fn(async () => undefined) }));
vi.mock("@/lib/uploads/recipientCaps", () => ({
  checkRecipientUploadCap: vi.fn(async () => ({ ok: true })),
  RECIPIENT_UPLOAD_LIMIT_CODE: "recipient_upload_limit",
}));
vi.mock("@/lib/http/rateLimit", () => ({
  clientIpFromRequest: () => "203.0.113.7",
  rateLimit: vi.fn(async () => ({ ok: true })),
  rateLimitedResponse: () => NextResponse.json({ error: "rate_limited" }, { status: 429 }),
}));
vi.mock("@/lib/botId", () => ({ BOT_ID_HEADER: "x-lnkdrp-botid" }));
// The upload page is a server component whose only job here is the lookup; its client half drags
// in React and is not what this file is about.
vi.mock("@/app/r/[token]/pageClient", () => ({ default: () => null }));
vi.mock("@/components/BrandHeader", () => ({ default: () => null }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const { PATCH: projectPATCH } = await import("@/app/api/projects/[projectSlug]/route");
const { POST: uploadsPOST } = await import("@/app/api/requests/[token]/uploads/route");
const { default: requestUploadPage } = await import("@/app/r/[token]/page");
const { GET: requestViewPdfGET } = await import("@/app/api/request-view/[token]/docs/[docId]/pdf/route");

// --- helpers -----------------------------------------------------------------------------------

type FakeProject = Record<string, any> & { save: ReturnType<typeof vi.fn>; isModified: (f: string) => boolean };

/** A mongoose-ish request-repo document: enough surface for the PATCH handler to act on it. */
function fakeRequestRepo(overrides: Record<string, unknown> = {}): FakeProject {
  const touched = new Set<string>();
  const base: Record<string, any> = {
    _id: PROJECT,
    orgId: ORG,
    userId: USER,
    name: "Diligence drop",
    slug: "diligence-drop",
    description: "Send us the deck",
    autoAddFiles: true,
    shareEnabled: true,
    isRequest: true,
    requestUploadToken: OLD_UPLOAD_TOKEN,
    requestViewToken: OLD_VIEW_TOKEN,
    ...overrides,
  };
  const doc = new Proxy(base, {
    set(target, prop, value) {
      if (typeof prop === "string" && target[prop] !== value) touched.add(prop);
      target[prop as string] = value;
      return true;
    },
  }) as FakeProject;
  base.save = vi.fn(async () => doc);
  base.isModified = (field: string) => touched.has(field);
  return doc;
}

function patchRequest(body: Record<string, unknown>) {
  return new Request("https://app.lnkdrp.com/api/projects/" + PROJECT.toString(), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function callPatch(body: Record<string, unknown>) {
  return (await projectPATCH(patchRequest(body), {
    params: Promise.resolve({ projectSlug: PROJECT.toString() }),
  })) as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  secretCounter = 0;
  projectFindOne.mockReset();
});

// --- 1. rotation exists at all -----------------------------------------------------------------

describe("PATCH /api/projects/:id rotates request capability tokens", () => {
  test("`rotateRequestTokens: \"both\"` replaces both tokens and saves", async () => {
    const project = fakeRequestRepo();
    projectFindOne.mockResolvedValue(project);

    const res = await callPatch({ rotateRequestTokens: "both" });
    const json = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(project.requestUploadToken).not.toBe(OLD_UPLOAD_TOKEN);
    expect(project.requestViewToken).not.toBe(OLD_VIEW_TOKEN);
    // Both tokens are fresh and distinct from each other — one mint reused for the pair would
    // make the read link guessable from the upload link.
    expect(project.requestUploadToken).not.toBe(project.requestViewToken);
    // Same length/alphabet as the original mint in POST /api/requests.
    expect(newSecretToken).toHaveBeenCalledWith(32);
    expect(project.save).toHaveBeenCalledTimes(1);
    expect(json.project.request.tokensRotated).toEqual(["upload", "view"]);
  });

  test("a rotate-only body is not rejected for having no project name", async () => {
    const project = fakeRequestRepo();
    projectFindOne.mockResolvedValue(project);

    const res = await callPatch({ rotateRequestTokens: "upload" });

    // The pre-fix handler reached `if (!shareOnly && !name)` and answered 400 here, which is what
    // made the whole action unreachable rather than merely absent.
    expect(res.status).toBe(200);
    expect(project.name).toBe("Diligence drop");
    expect(project.description).toBe("Send us the deck");
    expect(project.autoAddFiles).toBe(true);
  });

  test("`upload` leaves the view token alone, and `view` leaves the upload token alone", async () => {
    const uploadOnly = fakeRequestRepo();
    projectFindOne.mockResolvedValue(uploadOnly);
    await callPatch({ rotateRequestTokens: "upload" });
    expect(uploadOnly.requestUploadToken).not.toBe(OLD_UPLOAD_TOKEN);
    expect(uploadOnly.requestViewToken).toBe(OLD_VIEW_TOKEN);

    const viewOnly = fakeRequestRepo();
    projectFindOne.mockResolvedValue(viewOnly);
    await callPatch({ rotateRequestTokens: "view" });
    expect(viewOnly.requestViewToken).not.toBe(OLD_VIEW_TOKEN);
    expect(viewOnly.requestUploadToken).toBe(OLD_UPLOAD_TOKEN);
  });

  test("the new upload token is never left empty (the model invariant would reject the row)", async () => {
    const project = fakeRequestRepo();
    projectFindOne.mockResolvedValue(project);
    await callPatch({ rotateRequestTokens: "both" });
    expect(String(project.requestUploadToken ?? "").trim().length).toBeGreaterThan(0);
    expect(project.isRequest).toBe(true);
  });

  test("an unknown rotate word is ignored rather than guessed at", async () => {
    const project = fakeRequestRepo();
    projectFindOne.mockResolvedValue(project);

    // `true` is the shape a hurried client sends; it must not rotate anything, and because it is
    // not a rotate the request falls back to needing a name like any other settings save.
    const res = await callPatch({ rotateRequestTokens: true });

    expect(res.status).toBe(400);
    expect(project.requestUploadToken).toBe(OLD_UPLOAD_TOKEN);
    expect(project.requestViewToken).toBe(OLD_VIEW_TOKEN);
  });

  test("rotating a project that is not a request repo is refused, not silently ignored", async () => {
    const plainProject = fakeRequestRepo({ isRequest: false, requestUploadToken: null, requestViewToken: null });
    projectFindOne.mockResolvedValue(plainProject);

    const res = await callPatch({ rotateRequestTokens: "both" });

    expect(res.status).toBe(400);
    expect(plainProject.save).not.toHaveBeenCalled();
    // Answering 200 would tell an owner a leaked link had been cut when there was no link.
    expect(newSecretToken).not.toHaveBeenCalled();
  });

  test("rotation resolves the project through the workspace-scoped, not-deleted match", async () => {
    projectFindOne.mockResolvedValue(fakeRequestRepo());
    await callPatch({ rotateRequestTokens: "both" });

    const filter = projectFindOne.mock.calls[0][0] as Record<string, any>;
    expect(JSON.stringify(filter)).toContain("isDeleted");
    expect(JSON.stringify(filter)).toContain(ORG.toString());
  });

  test("a rotation lands in the activity feed without the token values", async () => {
    projectFindOne.mockResolvedValue(fakeRequestRepo());
    await callPatch({ rotateRequestTokens: "both" });

    const row = recordActivity.mock.calls.map((c) => c[0] as any).find((a) => a?.meta?.scope === "requestTokens");
    expect(row).toBeTruthy();
    expect(row.meta.rotated).toEqual(["upload", "view"]);
    expect(JSON.stringify(row)).not.toContain(OLD_UPLOAD_TOKEN);
    expect(JSON.stringify(row)).not.toContain("freshToken");
  });

  test("a settings save that sends no rotate word rotates nothing", async () => {
    const project = fakeRequestRepo();
    projectFindOne.mockResolvedValue(project);

    await callPatch({ name: "Diligence drop", description: "Send us the deck", requestRequireAuthToUpload: true });

    expect(project.requestUploadToken).toBe(OLD_UPLOAD_TOKEN);
    expect(project.requestViewToken).toBe(OLD_VIEW_TOKEN);
    expect(project.requestRequireAuthToUpload).toBe(true);
  });
});

// --- 2. a deleted request repo stops answering for its own tokens ------------------------------

describe("a deleted request repo stops answering for its tokens", () => {
  test("`/r/:token` will not resolve a deleted repo", async () => {
    // `.lean()` chain, and the filter is the thing under test.
    const select = vi.fn(() => ({ lean: async () => null }));
    projectFindOne.mockReturnValue({ select } as any);

    await expect(
      requestUploadPage({ params: Promise.resolve({ token: OLD_UPLOAD_TOKEN }) } as any),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    expect(projectFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ requestUploadToken: OLD_UPLOAD_TOKEN, isDeleted: { $ne: true } }),
    );
  });

  test("`POST /api/requests/:token/uploads` will not accept a file into a deleted repo", async () => {
    const select = vi.fn(() => ({ lean: async () => null }));
    projectFindOne.mockReturnValue({ select } as any);

    const res = (await uploadsPOST(
      new Request("https://app.lnkdrp.com/api/requests/x/uploads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ originalFileName: "deck.pdf", contentType: "application/pdf", sizeBytes: 100 }),
      }),
      { params: Promise.resolve({ token: OLD_UPLOAD_TOKEN }) },
    )) as Response;

    expect(res.status).toBe(404);
    expect(projectFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ requestUploadToken: OLD_UPLOAD_TOKEN, isDeleted: { $ne: true } }),
    );
  });

  test("the view-token PDF proxy keeps the same clause (it already had it; this pins it)", async () => {
    const select = vi.fn(() => ({ lean: async () => null }));
    projectFindOne.mockReturnValue({ select } as any);

    const res = (await requestViewPdfGET(new Request("https://app.lnkdrp.com/pdf"), {
      params: Promise.resolve({ token: OLD_VIEW_TOKEN, docId: new Types.ObjectId().toString() }),
    })) as Response;

    expect(res.status).toBe(404);
    expect(projectFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ requestViewToken: OLD_VIEW_TOKEN, isDeleted: { $ne: true } }),
    );
  });
});
