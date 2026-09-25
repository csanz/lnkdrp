/**
 * `POST /api/share/:shareId/download-requests` on a locked data room (code review 2026-09-23, M8).
 *
 * The password gate runs on the link alone, before the document is looked up, so a room the caller
 * has no password for answers 401 for every document id, member or not, and the membership lookup
 * never runs. Before this the route resolved link and document together and answered 404 for an
 * id outside the room and 401 for one inside it: an inventory of the room, through the one thing
 * the password withholds (docs/SECURITY.md, 7.8).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveShareLink: vi.fn(),
  shareLinkUnlocked: vi.fn(),
  resolveProjectLink: vi.fn(),
  resolveProjectStatsTarget: vi.fn(),
  rateLimit: vi.fn(async () => ({ ok: true, retryAfterSec: 0 })),
  findOne: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/lib/share/links", () => ({ resolveShareLink: mocks.resolveShareLink, shareLinkUnlocked: mocks.shareLinkUnlocked }));
vi.mock("@/lib/share/projectLinks", () => ({ resolveProjectLink: mocks.resolveProjectLink }));
vi.mock("@/lib/share/projectPublic", () => ({ resolveProjectStatsTarget: mocks.resolveProjectStatsTarget }));
vi.mock("@/lib/models/User", () => ({ UserModel: { findById: vi.fn() } }));
vi.mock("@/lib/models/ShareDownloadRequest", () => ({
  ShareDownloadRequestModel: {
    findOne: () => ({ sort: () => ({ select: () => ({ lean: mocks.findOne }) }) }),
    create: mocks.create,
  },
}));
vi.mock("@/lib/email/sendTextEmail", () => ({ sendEmailContent: vi.fn() }));
vi.mock("@/lib/email/templates", () => ({ downloadRequestOwnerEmail: vi.fn(), downloadRequestReceivedEmail: vi.fn() }));
vi.mock("@/lib/email/workspaceIdentity", () => ({ workspaceForEmail: vi.fn() }));
vi.mock("@/lib/urls", () => ({ getPublicSiteBase: () => "http://localhost:3001" }));
vi.mock("@/lib/debug", () => ({ debugLog: () => undefined, debugWarn: () => undefined }));
vi.mock("@/lib/http/rateLimit", () => ({
  rateLimit: mocks.rateLimit,
  rateLimitedResponse: vi.fn(),
  clientIpFromRequest: () => "203.0.113.7",
}));
vi.mock("@/lib/http/errorResponse", () => ({ errorJson: vi.fn() }));
vi.mock("@/lib/models/Org", () => ({ ensurePersonalOrgForUserId: vi.fn() }));
vi.mock("@/lib/activity/log", () => ({ recordActivity: vi.fn() }));

const { POST } = await import("@/app/api/share/[shareId]/download-requests/route");

const ROOM = "roomslug12345";
const IN_ROOM = "64b0c0ffee0000000000e003";
const NOT_IN_ROOM = "64b0c0ffee0000000000e004";

function post(docId: string): Promise<Response> {
  return POST(
    new Request(`http://localhost:3001/api/share/${ROOM}/download-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "reader@example.com", docId }),
    }),
    { params: Promise.resolve({ shareId: ROOM }) },
  );
}

describe("download request on a locked data room", () => {
  beforeEach(() => {
    mocks.resolveShareLink.mockReset().mockResolvedValue(null);
    mocks.resolveProjectLink.mockReset().mockResolvedValue({
      link: { shareId: ROOM, passwordHash: "h", passwordSalt: "s", allowDownload: false },
      project: { _id: "p" },
      refusal: null,
    });
    mocks.shareLinkUnlocked.mockReset().mockReturnValue(false);
    mocks.resolveProjectStatsTarget.mockReset().mockImplementation(async ({ bodyDocId }: { bodyDocId: string }) =>
      bodyDocId === IN_ROOM
        ? { link: { shareId: ROOM, allowDownload: false }, project: { _id: "p" }, doc: { _id: IN_ROOM, title: "In" }, refusal: null }
        : null,
    );
  });

  it("answers the same 401 for a document inside the room and one outside it", async () => {
    const inside = await post(IN_ROOM);
    const outside = await post(NOT_IN_ROOM);
    expect(inside.status).toBe(401);
    expect(outside.status).toBe(401);
    expect(await inside.text()).toBe(await outside.text());
  });

  it("never looks the document up while the room is locked", async () => {
    await post(IN_ROOM);
    await post(NOT_IN_ROOM);
    expect(mocks.resolveProjectStatsTarget).not.toHaveBeenCalled();
    expect(mocks.shareLinkUnlocked).toHaveBeenCalledTimes(2);
  });

  it("looks the document up once the room is unlocked, and 404s an id outside it", async () => {
    mocks.shareLinkUnlocked.mockReturnValue(true);
    mocks.findOne.mockResolvedValue(null);
    mocks.create.mockResolvedValue({ _id: "req" });
    const outside = await post(NOT_IN_ROOM);
    expect(outside.status).toBe(404);
    expect(mocks.resolveProjectStatsTarget).toHaveBeenCalledTimes(1);
  });
});
