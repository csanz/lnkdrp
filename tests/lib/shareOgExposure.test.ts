/**
 * Two ways the public preview of a share link leaked more than the link itself allows.
 *
 * - `buildShareMetadata` published any absolute `previewUrl` verbatim as `og:image`, and the value
 *   callers had to hand was the document's stored blob URL — `docs/<docId>/uploads/<uploadId>/
 *   preview.png`. The internal document and upload ids were therefore in the page source of every
 *   share page, readable by anyone the link was forwarded to and by any bot that unfurled it. The
 *   only preview the card may name is a path on our own origin (`/s/<shareId>/og.png`), which
 *   re-serves the bytes and re-runs the link's own checks.
 * - `/s/:shareId/og.png` does run those checks — `notFound()` for a refused or password-protected
 *   link — but it shipped `public, s-maxage=3600, stale-while-revalidate=86400`. A shared cache is
 *   keyed on the URL alone, so once warmed it kept serving the title and the first page for a day
 *   after the owner revoked the link; the per-request checks were simply not reached.
 *
 * Both are pinned on the value actually emitted (the `og:image` URL, the `Cache-Control` header),
 * because that string is the whole protection — the resolver underneath was never the bug.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const BLOB_PREVIEW =
  "https://blob.vercel-storage.com/docs/68c1f0aa0d2b4e0012abcd34/uploads/68c1f0aa0d2b4e0012abcd99/preview.png";
const SHARE_ID = "sh_abc123";

// --- shared module mocks -----------------------------------------------------------------------

const headersGet = vi.fn((name: string) => (name === "host" ? "app.lnkdrp.com" : null));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => ({ get: headersGet })) }));
vi.mock("@/lib/urls", () => ({ getMetadataBaseUrl: () => new URL("https://app.lnkdrp.com") }));

const resolveShareLink = vi.fn();
vi.mock("@/lib/share/links", () => ({ resolveShareLink: (...a: any[]) => (resolveShareLink as any)(...a) }));

class NotFoundError extends Error {}
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundError("NEXT_NOT_FOUND");
  },
}));

/** Captures what the route asks `imageResponseFromBytes` to put on the response. */
const imageResponseFromBytes = vi.fn((params: { cacheControl?: string }) => ({
  kind: "bytes" as const,
  cacheControl: params.cacheControl ?? null,
}));
vi.mock("@/lib/og/imageResponse", () => ({
  DEFAULT_OG_SIZE: { width: 1200, height: 630 },
  imageResponseFromBytes: (...a: any[]) => (imageResponseFromBytes as any)(...a),
  mimeFromPath: () => "image/png",
  sniffImageDims: () => ({ width: 1200, height: 630 }),
}));

/** The fallback text card is a real `ImageResponse`; we only need its headers. */
vi.mock("next/og", () => ({
  ImageResponse: class {
    headers = new Headers();
    constructor(
      public element: unknown,
      public opts: unknown,
    ) {}
  },
}));

import { buildShareMetadata } from "@/lib/share/shareMetadata";
import { GET as ogRoute } from "@/app/s/[shareId]/og.png/route";

/** Pull the single `og:image` URL out of the metadata the helper built. */
function ogImageUrl(meta: Awaited<ReturnType<typeof buildShareMetadata>>): string {
  const images = meta.openGraph?.images;
  const first = Array.isArray(images) ? images[0] : images;
  const url = (first as { url?: unknown })?.url;
  return String(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveShareLink.mockReset();
});

describe("share card never names the blob", () => {
  test("an absolute preview URL is refused, so no doc/upload id reaches og:image", async () => {
    const meta = await buildShareMetadata({
      title: "Series B deck",
      description: "d",
      previewUrl: BLOB_PREVIEW,
    });

    const url = ogImageUrl(meta);
    expect(url).toBe("https://app.lnkdrp.com/images/og.png");
    expect(url).not.toContain("68c1f0aa0d2b4e0012abcd34");
    expect(url).not.toContain("68c1f0aa0d2b4e0012abcd99");
    expect(url).not.toContain("blob.vercel-storage.com");

    // twitter:image is built from the same list — it must not be the escape hatch.
    const twitter = meta.twitter as { images?: unknown } | undefined;
    const twitterFirst = Array.isArray(twitter?.images) ? twitter.images[0] : twitter?.images;
    expect(String((twitterFirst as { url?: unknown })?.url)).not.toContain("blob.vercel-storage.com");
  });

  test("a protocol-relative value is refused too (it resolves off-origin)", async () => {
    const meta = await buildShareMetadata({
      title: "t",
      description: "d",
      previewUrl: "//blob.vercel-storage.com/docs/abc/preview.png",
    });
    expect(ogImageUrl(meta)).toBe("https://app.lnkdrp.com/images/og.png");
  });

  test("the same-origin proxy path is still the way to show a real preview", async () => {
    const meta = await buildShareMetadata({
      title: "t",
      description: "d",
      previewUrl: `/s/${SHARE_ID}/og.png`,
    });
    expect(ogImageUrl(meta)).toBe(`https://app.lnkdrp.com/s/${SHARE_ID}/og.png`);
  });
});

describe("/s/:shareId/og.png is not cacheable by a shared cache", () => {
  const params = Promise.resolve({ shareId: SHARE_ID });

  test("the rendered preview refuses `public`/`s-maxage`", async () => {
    resolveShareLink.mockResolvedValue({
      refusal: null,
      link: {},
      doc: { title: "Series B deck", previewImageUrl: BLOB_PREVIEW },
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
      headers: { get: () => "image/png" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await ogRoute({} as never, { params });

    expect(imageResponseFromBytes).toHaveBeenCalledTimes(1);
    const cacheControl = String(imageResponseFromBytes.mock.calls[0]![0].cacheControl);
    expect(cacheControl).toContain("private");
    expect(cacheControl).not.toContain("public");
    expect(cacheControl).not.toContain("s-maxage");
    expect(cacheControl).not.toContain("stale-while-revalidate");

    vi.unstubAllGlobals();
  });

  test("the text-card fallback refuses them as well", async () => {
    resolveShareLink.mockResolvedValue({ refusal: null, link: {}, doc: { title: "Series B deck" } });

    const res = (await ogRoute({} as never, { params })) as unknown as { headers: Headers };

    const cacheControl = String(res.headers.get("Cache-Control"));
    expect(cacheControl).toContain("private");
    expect(cacheControl).not.toContain("public");
    expect(cacheControl).not.toContain("s-maxage");
    expect(cacheControl).not.toContain("stale-while-revalidate");
  });

  test("a revoked or locked link still gets nothing at all", async () => {
    resolveShareLink.mockResolvedValueOnce({ refusal: "disabled", link: {}, doc: {} });
    await expect(ogRoute({} as never, { params })).rejects.toBeInstanceOf(NotFoundError);

    resolveShareLink.mockResolvedValueOnce({
      refusal: null,
      link: { passwordHash: "h", passwordSalt: "s" },
      doc: { title: "Series B deck" },
    });
    await expect(ogRoute({} as never, { params })).rejects.toBeInstanceOf(NotFoundError);
  });
});
