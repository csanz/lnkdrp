/**
 * `/s/:shareId/preview` — the document twin of the data room's preview proxy.
 *
 * `/s/:shareId` rendered its fallback straight from `previewImageUrl`, which is a Vercel Blob URL
 * on a public, unauthenticated CDN. So a recipient walked away with a permanent copy of the first
 * page, and with the document and upload ids, which are in the path. Every other artifact the
 * pipeline writes hangs off that same prefix — every page image, and `extracted.txt`, which is the
 * whole document as text. One URL was the step from "a recipient" to all of it, and none of it
 * stopped working when the link was revoked.
 *
 * What is pinned here is the gate, not the image: this route hands over bytes, so it has to ask the
 * same questions the page asks, in the same order, and it must not depend on the page having asked
 * them first.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const SHARE_ID = "aB3xY7zQ";
const PREVIEW = "https://store1.public.blob.vercel-storage.com/docs/d1/uploads/u1/preview.png";

const resolveShareLink = vi.fn();
const shareLinkUnlocked = vi.fn(() => true);
const fetchStoredBlob = vi.fn();

vi.mock("@/lib/share/links", () => ({
  resolveShareLink: (...a: unknown[]) => (resolveShareLink as never as (...x: unknown[]) => unknown)(...a),
  shareLinkUnlocked: (...a: unknown[]) => (shareLinkUnlocked as never as (...x: unknown[]) => unknown)(...a),
}));
vi.mock("@/lib/blob/fetchStoredBlob", () => ({
  fetchStoredBlob: (...a: unknown[]) => (fetchStoredBlob as never as (...x: unknown[]) => unknown)(...a),
}));

const { GET } = await import("@/app/s/[shareId]/preview/route");

/** A real PNG header, because the route decides the content type from the bytes. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

function upstream(bytes: Buffer, contentLength?: string) {
  return {
    ok: true,
    headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? (contentLength ?? String(bytes.length)) : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

const run = () => GET(new Request(`http://localhost/s/${SHARE_ID}/preview`), { params: Promise.resolve({ shareId: SHARE_ID }) });

beforeEach(() => {
  vi.clearAllMocks();
  shareLinkUnlocked.mockReturnValue(true);
  fetchStoredBlob.mockResolvedValue(upstream(PNG));
  resolveShareLink.mockResolvedValue({ refusal: null, link: {}, doc: { previewImageUrl: PREVIEW } });
});

describe("the gate", () => {
  test("a live, unlocked link gets the image", async () => {
    const res = await run();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    // Ours, not the store's, so a browser must not second-guess it.
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("a refused link hands over nothing, and never asks the store", async () => {
    resolveShareLink.mockResolvedValue({ refusal: "disabled", link: {}, doc: { previewImageUrl: PREVIEW } });

    const res = await run();

    expect(res.status).toBe(404);
    expect(fetchStoredBlob).not.toHaveBeenCalled();
  });

  test("a locked link hands over nothing, and never asks the store", async () => {
    shareLinkUnlocked.mockReturnValue(false);

    const res = await run();

    expect(res.status).toBe(401);
    expect(fetchStoredBlob).not.toHaveBeenCalled();
  });

  test("the password is asked unconditionally, not behind an `if`", async () => {
    // `shareLinkUnlocked` answers true for a link with no password, so it is safe to call always —
    // and calling it always is what stops the gate being lost by forgetting a branch, which is how
    // it was lost on the analytics ingest once.
    await run();

    expect(shareLinkUnlocked).toHaveBeenCalledTimes(1);
  });
});

describe("what it is willing to serve", () => {
  test("a document with no preview is a 404, not an empty image", async () => {
    resolveShareLink.mockResolvedValue({ refusal: null, link: {}, doc: {} });

    expect((await run()).status).toBe(404);
    expect(fetchStoredBlob).not.toHaveBeenCalled();
  });

  test("a pointer the allowlist refuses is a 404", async () => {
    // `fetchStoredBlob` returns null for a URL that is not ours, and for one that redirects off
    // the store. Both are the same answer here.
    fetchStoredBlob.mockResolvedValue(null);

    expect((await run()).status).toBe(404);
  });

  test("bytes that are not an image we write are refused", async () => {
    // The PDF proxy learned this one the hard way: an upstream answering `text/html`, with the
    // type echoed rather than pinned, made this origin serve markup.
    fetchStoredBlob.mockResolvedValue(upstream(Buffer.from("<html><script>alert(1)</script>")));

    expect((await run()).status).toBe(404);
  });

  test("an oversized preview is refused on the declared length, before it is read", async () => {
    fetchStoredBlob.mockResolvedValue(upstream(PNG, String(9 * 1024 * 1024)));

    expect((await run()).status).toBe(404);
  });
});

describe("caching", () => {
  test("the bytes are private, because they are scoped to whoever passed the gate", async () => {
    const res = await run();

    // A shared cache is keyed on the URL alone and would serve a locked link's first page to
    // anyone who asked for it.
    const cacheControl = res.headers.get("cache-control") ?? "";
    expect(cacheControl).toContain("private");
    expect(cacheControl).not.toContain("s-maxage");
  });
});
