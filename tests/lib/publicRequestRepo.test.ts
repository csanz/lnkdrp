/**
 * `/p/:shareId` is for data rooms, and a request repo is not one — the rule, and why, is written at
 * `src/app/p/[shareId]/page.tsx`.
 *
 * The finding's path needs no account at any step: a workspace member reads the repo's `shareId`
 * out of `GET /api/projects` (viewer-role is enough, and a removed member keeps whatever they
 * noted), hands the URL to anyone, and `/p/<slug>` listed every file third parties had uploaded —
 * `/p/<slug>/<docId>/pdf` then streamed them. So the guard is tested where the bytes are.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const { resolveProjectDocument, shareViewUpdateOne, projectLinkViewUpdateOne, touchShareLink, isOwnerSideViewer } =
  vi.hoisted(() => ({
    resolveProjectDocument: vi.fn(),
    shareViewUpdateOne: vi.fn(),
    projectLinkViewUpdateOne: vi.fn(),
    touchShareLink: vi.fn(),
    isOwnerSideViewer: vi.fn(),
  }));

vi.mock("@/lib/share/projectPublic", () => ({
  resolveProjectDocument,
  projectLinkPasswordEnabled: () => false,
  projectViewerKey: (botIdHash: string, docId: unknown) => `${botIdHash}.${String(docId)}`,
}));
vi.mock("@/lib/models/ShareView", () => ({ ShareViewModel: { updateOne: shareViewUpdateOne } }));
vi.mock("@/lib/models/ProjectLinkView", () => ({ ProjectLinkViewModel: { updateOne: projectLinkViewUpdateOne } }));
vi.mock("@/lib/models/Org", () => ({ ensurePersonalOrgForUserId: vi.fn() }));
vi.mock("@/lib/share/links", () => ({ touchShareLink }));
vi.mock("@/lib/share/ownerSide", () => ({ isOwnerSideViewer }));
vi.mock("@/lib/activity/log", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/gating/actor", () => ({ tryResolveAuthUserId: vi.fn(async () => null) }));
vi.mock("@/lib/http/rateLimit", () => ({ clientIpFromRequest: () => "203.0.113.9" }));

const { GET } = await import("@/app/p/[shareId]/[docId]/pdf/route");

const SHARE_ID = "prFo9KkQm2Tb";
const DOC_ID = new Types.ObjectId();

function resolvedRoom(project: Record<string, unknown>) {
  return {
    link: { _id: new Types.ObjectId(), label: "Data room", isDefault: true, allowDownload: true, passwordHash: null, passwordSalt: null },
    project: { _id: new Types.ObjectId(), orgId: new Types.ObjectId(), name: "Acme", ...project },
    doc: { _id: DOC_ID, blobUrl: "https://blob.test/secret.pdf", title: "Submission", fileName: "submission.pdf" },
    refusal: null,
  };
}

/** Anonymous, no cookies — the attacker in the finding. */
function get(query = "") {
  return GET(new Request(`https://lnkdrp.test/p/${SHARE_ID}/${DOC_ID}/pdf${query}`), {
    params: Promise.resolve({ shareId: SHARE_ID, docId: String(DOC_ID) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  isOwnerSideViewer.mockResolvedValue(false);
  shareViewUpdateOne.mockResolvedValue({ upsertedCount: 1 });
  projectLinkViewUpdateOne.mockResolvedValue({ acknowledged: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("%PDF-1.7", { status: 200, headers: { "content-type": "application/pdf" } })),
  );
});

describe("GET /p/:shareId/:docId/pdf", () => {
  test("a submission to a request repo is a 404, and its bytes are never fetched", async () => {
    resolveProjectDocument.mockResolvedValue(resolvedRoom({ isRequest: true }));

    const res = await get("?download=1&botId=abc");

    expect(res.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
    // Not even a view row: nothing about the repo is observable through this URL.
    expect(shareViewUpdateOne).not.toHaveBeenCalled();
    expect(projectLinkViewUpdateOne).not.toHaveBeenCalled();
  });

  test("the guard does not touch a real data room", async () => {
    resolveProjectDocument.mockResolvedValue(resolvedRoom({ isRequest: false }));

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("the project is asked for `isRequest`, or the guard would read an unselected field as absent", async () => {
    // `PROJECT_SHARE_FIELDS` does not carry it, and a field nobody selected comes back `undefined`
    // — which passes the check while proving nothing. The projection is part of the guard.
    resolveProjectDocument.mockResolvedValue(resolvedRoom({ isRequest: false }));
    await get();
    const [, , opts] = resolveProjectDocument.mock.calls[0] as [string, string, { projectSelect?: Record<string, 1> }];
    expect(opts.projectSelect).toMatchObject({ isRequest: 1 });
  });
});
