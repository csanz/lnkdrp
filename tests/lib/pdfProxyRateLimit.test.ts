/**
 * The two public PDF proxies were unauthenticated, side-effecting GETs with no limiter at all.
 *
 * `GET /s/:shareId/pdf?download=1&botId=<anything>` and its project twin
 * `GET /p/:shareId/:docId/pdf` each take the analytics identity of the "reader" straight from the
 * query string and then write: a `ShareView` upsert, the link's `downloadCount` and "Last viewed",
 * the document's `numberOfViews` on a first sighting, a `ProjectLinkView` row on the project route,
 * and a row in the owner's activity feed. Nothing bounded how often a stranger holding the link
 * could do that, and because the upstream fetch happens *after* the writes, `Range: bytes=0-0` made
 * each invented reader cost about a byte of bandwidth. The stats ingest had been bounding exactly
 * this shape for the whole time (`sharestats:ip:<ip>`); these two routes simply never got it.
 *
 * What is pinned here, in the filters-issued style of tests/lib/deletedDocAndOwnerDownload.test.ts:
 *
 * - the limiter runs *before* any write, under both a per-link and a wider per-IP bucket;
 * - its key is built from proxy-set forwarding headers only, so a caller who invents a
 *   `cf-connecting-ip` cannot mint a fresh bucket per request (that header still feeds the
 *   `viewerIp` the row records — attribution, not identity);
 * - a refused caller writes nothing **and is still served their PDF**, because a noisy-neighbour
 *   limit must never become a broken download;
 * - a Range continuation of one real read stops counting as a separate download.
 *
 * `rateLimit` is the only thing faked out of `@/lib/http/rateLimit` — `clientIpFromRequest` runs for
 * real, or the key assertions would be testing the mock.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const ORG = new Types.ObjectId();
const OWNER = new Types.ObjectId();
const DOC = new Types.ObjectId();
const LINK = new Types.ObjectId();
const PROJECT = new Types.ObjectId();

/** The IP a proxy actually vouches for, and the one a caller can type into a header themselves. */
const PROXY_IP = "203.0.113.9";
const SPOOFED_IP = "198.51.100.7";

const rateLimit = vi.fn(async (_input: unknown) => ({ ok: true, remaining: 29, retryAfterSec: 0 }));
const shareViewUpdateOne = vi.fn(async (..._a: unknown[]) => ({ upsertedCount: 1 }));
const projectLinkViewUpdateOne = vi.fn(async (..._a: unknown[]) => ({ upsertedCount: 1 }));
const docUpdateOne = vi.fn(async (..._a: unknown[]) => ({ matchedCount: 1 }));
const touchShareLink = vi.fn(async (..._a: unknown[]) => undefined);
const recordActivity = vi.fn(async (..._a: unknown[]) => undefined);
const isOwnerSideViewer = vi.fn(async () => false);

const doc = {
  _id: DOC,
  blobUrl: "https://blob.test/deck.pdf",
  title: "Deck",
  fileName: "deck.pdf",
  orgId: ORG,
  userId: OWNER,
};
const link = { _id: LINK, passwordHash: null, passwordSalt: null, allowDownload: true, label: null, isDefault: true };

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/debug", () => ({ debugError: vi.fn(), debugLog: vi.fn() }));

// Partial mock on purpose: `clientIpFromRequest` is the half under test.
vi.mock("@/lib/http/rateLimit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/http/rateLimit")>();
  return { ...actual, rateLimit: (...a: unknown[]) => (rateLimit as never as (...x: unknown[]) => unknown)(...a) };
});

vi.mock("@/lib/models/ShareView", () => ({
  ShareViewModel: {
    updateOne: (...a: unknown[]) => (shareViewUpdateOne as never as (...x: unknown[]) => unknown)(...a),
    // The activity feed's name lookup: `.select().lean().catch()`.
    findOne: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }),
  },
}));
vi.mock("@/lib/models/Doc", () => ({
  DocModel: { updateOne: (...a: unknown[]) => (docUpdateOne as never as (...x: unknown[]) => unknown)(...a) },
}));
vi.mock("@/lib/models/ProjectLinkView", () => ({
  ProjectLinkViewModel: {
    updateOne: (...a: unknown[]) => (projectLinkViewUpdateOne as never as (...x: unknown[]) => unknown)(...a),
  },
}));
vi.mock("@/lib/models/Org", () => ({ ensurePersonalOrgForUserId: vi.fn(async () => ({ orgId: ORG })) }));
vi.mock("@/lib/activity/log", () => ({
  recordActivity: (...a: unknown[]) => (recordActivity as never as (...x: unknown[]) => unknown)(...a),
}));
vi.mock("@/lib/share/ownerSide", () => ({
  isOwnerSideViewer: (...a: unknown[]) => (isOwnerSideViewer as never as (...x: unknown[]) => unknown)(...a),
}));
vi.mock("@/lib/gating/actor", () => ({ tryResolveAuthUserId: vi.fn(async () => null) }));
vi.mock("@/lib/share/links", () => ({
  resolveShareLink: vi.fn(async () => ({ refusal: null, link, doc })),
  touchShareLink: (...a: unknown[]) => (touchShareLink as never as (...x: unknown[]) => unknown)(...a),
}));
vi.mock("@/lib/share/projectPublic", () => ({
  resolveProjectDocument: vi.fn(async () => ({
    refusal: null,
    link,
    project: { _id: PROJECT, name: "Data room", orgId: ORG, isRequest: false },
    doc,
  })),
  projectLinkPasswordEnabled: () => false,
  projectViewerKey: (hash: string, docId: unknown) => `${hash}:${String(docId)}`,
}));

/** Let the routes' fire-and-forget analytics writes land. */
async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
}

function download(path: string, extraHeaders: Record<string, string> = {}) {
  return new Request(`http://localhost${path}`, {
    headers: {
      // A caller-supplied header the route trusts for attribution but must not trust for bucketing.
      "cf-connecting-ip": SPOOFED_IP,
      "x-forwarded-for": PROXY_IP,
      ...extraHeaders,
    },
  });
}

function limiterKeys(): string[] {
  return rateLimit.mock.calls.map((c) => String((c[0] as { key?: unknown })?.key ?? ""));
}

beforeEach(() => {
  vi.clearAllMocks();
  rateLimit.mockResolvedValue({ ok: true, remaining: 29, retryAfterSec: 0 } as never);
  shareViewUpdateOne.mockResolvedValue({ upsertedCount: 1 } as never);
  isOwnerSideViewer.mockResolvedValue(false as never);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { "content-length": "4" } })),
  );
});

describe("GET /s/:shareId/pdf", () => {
  async function get(url: string, headers?: Record<string, string>) {
    const { GET } = await import("@/app/s/[shareId]/pdf/route");
    const res = await GET(download(url, headers), { params: Promise.resolve({ shareId: "abc123" }) });
    await settle();
    return res;
  }

  test("the tracking write is bounded, per link and per IP, on the proxy-vouched address", async () => {
    await get("/s/abc123/pdf?download=1&botId=bot-1");

    const keys = limiterKeys();
    expect(keys).toContain(`sharepdf:abc123:${PROXY_IP}`);
    expect(keys).toContain(`sharepdf:ip:${PROXY_IP}`);
    // The wider bucket exists so walking across every link you hold is not a way round the first.
    expect(keys.length).toBe(2);
    // A bucket minted from `cf-connecting-ip` would be a fresh bucket on every request.
    expect(keys.join("|")).not.toContain(SPOOFED_IP);
    // Both buckets are a real ceiling per window, not a per-request formality.
    for (const call of rateLimit.mock.calls) {
      const input = call[0] as { limit?: unknown; windowMs?: unknown };
      expect(typeof input.limit).toBe("number");
      expect(Number(input.limit)).toBeLessThanOrEqual(200);
      expect(Number(input.windowMs)).toBeGreaterThanOrEqual(1000);
    }
    // ...and a caller within the limit is tracked exactly as before.
    expect(shareViewUpdateOne).toHaveBeenCalledTimes(1);
  });

  test("a refused caller moves no counter", async () => {
    rateLimit.mockResolvedValue({ ok: false, remaining: 0, retryAfterSec: 30 } as never);

    await get("/s/abc123/pdf?download=1&botId=flood-1");

    // This is the whole finding: unbounded, each of these fires once per request, forever.
    expect(shareViewUpdateOne).not.toHaveBeenCalled();
    expect(docUpdateOne).not.toHaveBeenCalled();
    expect(touchShareLink).not.toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();
  });

  test("a refused caller still gets the PDF", async () => {
    rateLimit.mockResolvedValue({ ok: false, remaining: 0, retryAfterSec: 30 } as never);

    const res = await get("/s/abc123/pdf?download=1&botId=flood-1");

    // Refusing the bytes would punish everyone behind one office NAT for one bad neighbour. Only the
    // counter move is withheld.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("attachment");
  });

  test("the limiter is consulted before anything is written", async () => {
    let writeSeenAt = -1;
    let limiterCalls = 0;
    rateLimit.mockImplementation(async () => {
      limiterCalls += 1;
      return { ok: true, remaining: 29, retryAfterSec: 0 };
    });
    shareViewUpdateOne.mockImplementation(async () => {
      writeSeenAt = limiterCalls;
      return { upsertedCount: 1 };
    });

    await get("/s/abc123/pdf?download=1&botId=bot-1");

    // A limiter that ran after the upsert would bound nothing that matters.
    expect(writeSeenAt).toBe(2);
  });

  test("a range continuation of one read is served without counting again", async () => {
    await get("/s/abc123/pdf?download=1&botId=bot-1", { range: "bytes=1048576-" });

    // Same reader, same botId, second chunk: one read, not two downloads. Nothing is even spent on
    // the limiter for it.
    expect(rateLimit).not.toHaveBeenCalled();
    expect(shareViewUpdateOne).not.toHaveBeenCalled();
    // The range still reaches the blob store untouched — pdf.js depends on it.
    const fetchMock = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
    expect((fetchMock.mock.calls[0]?.[1] as { headers?: Record<string, string> })?.headers?.range).toBe("bytes=1048576-");
  });

  test("the request that starts at byte 0 is still the read", async () => {
    await get("/s/abc123/pdf?download=1&botId=bot-1", { range: "bytes=0-1023" });

    expect(shareViewUpdateOne).toHaveBeenCalledTimes(1);
  });
});

describe("GET /p/:shareId/:docId/pdf", () => {
  async function get(url: string, headers?: Record<string, string>) {
    const { GET } = await import("@/app/p/[shareId]/[docId]/pdf/route");
    const res = await GET(download(url, headers), { params: Promise.resolve({ shareId: "room9", docId: DOC.toString() }) });
    await settle();
    return res;
  }

  test("the same two buckets guard the project twin", async () => {
    await get(`/p/room9/${DOC.toString()}/pdf?download=1&botId=bot-1`);

    const keys = limiterKeys();
    expect(keys).toContain(`sharepdf:room9:${PROXY_IP}`);
    expect(keys).toContain(`sharepdf:ip:${PROXY_IP}`);
    expect(keys.join("|")).not.toContain(SPOOFED_IP);
    expect(shareViewUpdateOne).toHaveBeenCalledTimes(1);
    expect(projectLinkViewUpdateOne).toHaveBeenCalledTimes(1);
  });

  test("a refused caller writes neither row, and still gets the PDF", async () => {
    rateLimit.mockResolvedValue({ ok: false, remaining: 0, retryAfterSec: 30 } as never);

    const res = await get(`/p/room9/${DOC.toString()}/pdf?download=1&botId=flood-1`);

    // The louder half of the pair: one project link fans out over every document in the room, and
    // each request wrote two rows plus a feed entry.
    expect(shareViewUpdateOne).not.toHaveBeenCalled();
    expect(projectLinkViewUpdateOne).not.toHaveBeenCalled();
    expect(touchShareLink).not.toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
  });

  test("a range continuation does not count as another download", async () => {
    await get(`/p/room9/${DOC.toString()}/pdf?download=1&botId=bot-1`, { range: "bytes=4096-" });

    expect(rateLimit).not.toHaveBeenCalled();
    expect(shareViewUpdateOne).not.toHaveBeenCalled();
    expect(projectLinkViewUpdateOne).not.toHaveBeenCalled();
  });
});
