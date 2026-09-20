/**
 * "Allow download: off" did not stop the PDF bytes — it stopped one query string.
 *
 * Both public proxies gated on `wantsDownload && !link.allowDownload`, and `wantsDownload` is
 * `?download=1`, which the caller types. Drop it and the handler fell straight through to the blob
 * fetch and returned the identical bytes, the only difference being `content-disposition: inline`
 * instead of `attachment`. So a recipient the sender had explicitly marked no-download took the
 * whole original PDF by editing the address bar, and — because the tracking block lives inside the
 * same `wantsDownload` guard — the owner's dashboard went on reporting zero downloads.
 *
 * The gate now asks what the request *is* rather than what it claims. `Sec-Fetch-Site` and
 * `Sec-Fetch-Dest` are stamped by the browser and unforgeable from page script: the viewer reads
 * the file as a `same-origin` subresource (`empty` for pdf.js, `iframe` for the native fallback),
 * while an address-bar open reports `none`, a foreign embed `cross-site`, and a top-level open
 * `dest: document`.
 *
 * What is pinned here, in the filters-issued style of tests/lib/pdfProxyRateLimit.test.ts:
 *
 * - on a no-download link a raw pull is refused **before the blob is fetched**, so the bytes never
 *   leave the server — asserting the status alone would pass against a route that fetched the PDF
 *   and then thought better of it;
 * - the viewer's own same-origin subresource fetch still gets its document, on the same link;
 * - a request with no Fetch Metadata at all is still served, which is a deliberate choice and not
 *   an oversight: old browsers omit the headers, and so does the app's own server-side importer
 *   (`/api/uploads/:uploadId/import-url` fetches `/s/:shareId/pdf`);
 * - a link that *does* allow downloads is unaffected in every shape.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const ORG = new Types.ObjectId();
const OWNER = new Types.ObjectId();
const DOC = new Types.ObjectId();
const LINK = new Types.ObjectId();
const PROJECT = new Types.ObjectId();

const shareViewUpdateOne = vi.fn(async (..._a: unknown[]) => ({ upsertedCount: 1 }));
const projectLinkViewUpdateOne = vi.fn(async (..._a: unknown[]) => ({ upsertedCount: 1 }));
const touchShareLink = vi.fn(async (..._a: unknown[]) => undefined);
const recordActivity = vi.fn(async (..._a: unknown[]) => undefined);

const doc = {
  _id: DOC,
  blobUrl: "https://blob.test/deck.pdf",
  title: "Deck",
  fileName: "deck.pdf",
  orgId: ORG,
  userId: OWNER,
};

/** Mutable: each test says whether this link permits downloads before calling the route. */
const link = {
  _id: LINK,
  passwordHash: null as string | null,
  passwordSalt: null as string | null,
  allowDownload: false,
  label: null as string | null,
  isDefault: true,
};

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/debug", () => ({ debugError: vi.fn(), debugLog: vi.fn() }));
vi.mock("@/lib/http/rateLimit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/http/rateLimit")>();
  return { ...actual, rateLimit: vi.fn(async () => ({ ok: true, remaining: 29, retryAfterSec: 0 })) };
});
vi.mock("@/lib/models/ShareView", () => ({
  ShareViewModel: {
    updateOne: (...a: unknown[]) => (shareViewUpdateOne as never as (...x: unknown[]) => unknown)(...a),
    findOne: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }),
  },
}));
vi.mock("@/lib/models/Doc", () => ({ DocModel: { updateOne: vi.fn(async () => ({ matchedCount: 1 })) } }));
vi.mock("@/lib/models/ProjectLinkView", () => ({
  ProjectLinkViewModel: {
    updateOne: (...a: unknown[]) => (projectLinkViewUpdateOne as never as (...x: unknown[]) => unknown)(...a),
  },
}));
vi.mock("@/lib/models/Org", () => ({ ensurePersonalOrgForUserId: vi.fn(async () => ({ orgId: ORG })) }));
vi.mock("@/lib/activity/log", () => ({
  recordActivity: (...a: unknown[]) => (recordActivity as never as (...x: unknown[]) => unknown)(...a),
}));
vi.mock("@/lib/share/ownerSide", () => ({ isOwnerSideViewer: vi.fn(async () => false) }));
vi.mock("@/lib/gating/actor", () => ({ tryResolveAuthUserId: vi.fn(async () => null) }));
vi.mock("@/lib/share/links", () => ({
  resolveShareLink: vi.fn(async () => ({ refusal: null, link, doc })),
  touchShareLink: (...a: unknown[]) => (touchShareLink as never as (...x: unknown[]) => unknown)(...a),
}));
// Two seams where there used to be one. `/p/:shareId/:docId/pdf` was reordered to close a data-room
// inventory oracle (tests/lib/projectPdfOracle.test.ts): it no longer resolves link and document in
// a single `resolveProjectDocument` call, it takes the link from `resolveProjectLink` and only asks
// `findProjectDocument` whether the room holds this id once the password gate is behind it. Mocking
// `resolveProjectDocument` alone left the route falling through to the real `resolveProjectLink`,
// which reaches for `MONGODB_URI`. The factory closes over the same mutable `link` object, so a test
// flipping `link.allowDownload` before the call still governs the gate under test.
vi.mock("@/lib/share/projectLinks", () => ({
  resolveProjectLink: vi.fn(async () => ({
    refusal: null,
    link,
    project: { _id: PROJECT, name: "Data room", orgId: ORG, isRequest: false },
  })),
}));
vi.mock("@/lib/share/projectPublic", () => ({
  findProjectDocument: vi.fn(async () => doc),
  projectLinkPasswordEnabled: () => false,
  projectViewerKey: (hash: string, docId: unknown) => `${hash}:${String(docId)}`,
}));

/** Let the routes' fire-and-forget analytics writes land. */
async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
}

/** How many times the handler reached the blob store. The bytes leaving is the actual failure. */
function blobFetchCount(): number {
  return (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
}

/** The headers a browser stamps for each way of asking for this URL. */
const AS_VIEWER = { "sec-fetch-site": "same-origin", "sec-fetch-dest": "empty" };
const AS_NATIVE_VIEWER_FRAME = { "sec-fetch-site": "same-origin", "sec-fetch-dest": "iframe" };
const AS_ADDRESS_BAR = { "sec-fetch-site": "none", "sec-fetch-dest": "document" };
const AS_NEW_TAB = { "sec-fetch-site": "same-origin", "sec-fetch-dest": "document" };
const AS_FOREIGN_EMBED = { "sec-fetch-site": "cross-site", "sec-fetch-dest": "embed" };

beforeEach(() => {
  vi.clearAllMocks();
  link.allowDownload = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { "content-length": "4" } })),
  );
});

describe("GET /s/:shareId/pdf on a link with downloads off", () => {
  async function get(path: string, headers: Record<string, string> = {}) {
    const { GET } = await import("@/app/s/[shareId]/pdf/route");
    const res = await GET(new Request(`http://localhost${path}`, { headers }), {
      params: Promise.resolve({ shareId: "abc123" }),
    });
    await settle();
    return res;
  }

  test("an address-bar pull is refused, and the PDF is never fetched", async () => {
    const res = await get("/s/abc123/pdf", AS_ADDRESS_BAR);

    // The whole finding: without `?download=1` this used to be a 200 carrying the original file.
    expect(res.status).toBe(403);
    // Refused *before* the blob fetch — a route that streamed the bytes and then returned 403 would
    // already have sent them.
    expect(blobFetchCount()).toBe(0);
  });

  test("opening the raw URL in a new tab from the share page is refused too", async () => {
    // Same-origin, so `Sec-Fetch-Site` alone would wave it through; it is the top-level `document`
    // destination that makes it a file grab rather than the viewer reading.
    const res = await get("/s/abc123/pdf", AS_NEW_TAB);

    expect(res.status).toBe(403);
    expect(blobFetchCount()).toBe(0);
  });

  test("another site embedding the URL is refused", async () => {
    const res = await get("/s/abc123/pdf", AS_FOREIGN_EMBED);

    expect(res.status).toBe(403);
    expect(blobFetchCount()).toBe(0);
  });

  test("the viewer's own fetch still gets the document", async () => {
    const res = await get("/s/abc123/pdf", AS_VIEWER);

    // The point of the link is that the recipient can read it. A gate that broke this would be a
    // no-download link that shows nothing.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("inline");
    expect(blobFetchCount()).toBe(1);
  });

  test("the native-PDF fallback frame is a read, not a grab", async () => {
    const res = await get("/s/abc123/pdf", AS_NATIVE_VIEWER_FRAME);

    expect(res.status).toBe(200);
    expect(blobFetchCount()).toBe(1);
  });

  test("a client that sends no Fetch Metadata is still served", async () => {
    // Deliberate, not a gap: browsers that predate these headers omit them, and so does the app's
    // own importer, which fetches `/s/:shareId/pdf` server-side to pull a deck in. Refusing here
    // would break real reads to inconvenience a client that picks its own headers anyway.
    const res = await get("/s/abc123/pdf");

    expect(res.status).toBe(200);
    expect(blobFetchCount()).toBe(1);
  });

  test("?download=1 is refused exactly as it always was", async () => {
    const res = await get("/s/abc123/pdf?download=1&botId=bot-1", AS_NEW_TAB);

    expect(res.status).toBe(403);
    expect(blobFetchCount()).toBe(0);
    // And a refused download moves no counter, which was already true and must stay true.
    expect(shareViewUpdateOne).not.toHaveBeenCalled();
    expect(touchShareLink).not.toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();
  });
});

describe("GET /s/:shareId/pdf on a link that allows downloads", () => {
  async function get(path: string, headers: Record<string, string> = {}) {
    const { GET } = await import("@/app/s/[shareId]/pdf/route");
    const res = await GET(new Request(`http://localhost${path}`, { headers }), {
      params: Promise.resolve({ shareId: "abc123" }),
    });
    await settle();
    return res;
  }

  beforeEach(() => {
    link.allowDownload = true;
  });

  test("every shape is served, because the sender said the file may be taken", async () => {
    for (const headers of [AS_ADDRESS_BAR, AS_NEW_TAB, AS_FOREIGN_EMBED, AS_VIEWER, {}]) {
      const res = await get("/s/abc123/pdf", headers);
      expect(res.status).toBe(200);
    }
  });

  test("an explicit download is still tracked and sent as an attachment", async () => {
    const res = await get("/s/abc123/pdf?download=1&botId=bot-1", AS_NEW_TAB);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(shareViewUpdateOne).toHaveBeenCalledTimes(1);
    expect(recordActivity).toHaveBeenCalled();
  });
});

describe("GET /p/:shareId/:docId/pdf", () => {
  async function get(path: string, headers: Record<string, string> = {}) {
    const { GET } = await import("@/app/p/[shareId]/[docId]/pdf/route");
    const res = await GET(new Request(`http://localhost${path}`, { headers }), {
      params: Promise.resolve({ shareId: "room9", docId: DOC.toString() }),
    });
    await settle();
    return res;
  }

  test("the project twin refuses a raw pull on a no-download room", async () => {
    const res = await get(`/p/room9/${DOC.toString()}/pdf`, AS_ADDRESS_BAR);

    // The louder half of the pair: one link fans out over every document in the room, so the old
    // gate let the whole data room be taken a URL at a time.
    expect(res.status).toBe(403);
    expect(blobFetchCount()).toBe(0);
    expect(shareViewUpdateOne).not.toHaveBeenCalled();
    expect(projectLinkViewUpdateOne).not.toHaveBeenCalled();
  });

  test("the room's viewer still reads the document", async () => {
    const res = await get(`/p/room9/${DOC.toString()}/pdf`, AS_VIEWER);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(blobFetchCount()).toBe(1);
  });

  test("a room that allows downloads is unaffected", async () => {
    link.allowDownload = true;

    const res = await get(`/p/room9/${DOC.toString()}/pdf?download=1&botId=bot-1`, AS_NEW_TAB);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(shareViewUpdateOne).toHaveBeenCalledTimes(1);
    expect(projectLinkViewUpdateOne).toHaveBeenCalledTimes(1);
  });
});
