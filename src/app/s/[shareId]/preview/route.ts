/**
 * Same-origin preview-image proxy for a document link: `/s/:shareId/preview`.
 *
 * The document twin of `/p/:shareId/:docId/preview`, which closed the same hole for data rooms.
 *
 * Why it exists: `/s/:shareId` rendered its "still preparing a PDF viewer" fallback straight from
 * `previewImageUrl`. That value is a Vercel Blob URL on a **public, unauthenticated CDN** —
 * `docs/<docId>/uploads/<uploadId>/preview.png` — so the page handed the recipient a permanent,
 * link-independent copy of the first page, with the document and upload ids spelled out in the
 * path. Revoking the link, letting it expire or adding a password did nothing to a URL somebody had
 * already saved.
 *
 * And the ids are the larger half. Every other artifact the pipeline writes hangs off that same
 * prefix — every page image, every thumbnail, and `extracted.txt`, which is the whole document as
 * text. One preview URL was the step from "a recipient" to all of it. Closing this does not make
 * the store private (see `docs/prds/lnkdrp-blob-privacy.md`), but it removes the only route a
 * recipient would ever be handed.
 *
 * Check order matches the page and the PDF proxy: resolve the link, apply its refusals, then the
 * password. A locked link must hand over nothing, including this.
 *
 * No analytics. A thumbnail is not a read, and counting it would invent a view that never happened.
 */
import { NextResponse } from "next/server";

import { fetchStoredBlob } from "@/lib/blob/fetchStoredBlob";
import { resolveShareLink, shareLinkUnlocked, type PasswordProtectedLink } from "@/lib/share/links";

export const runtime = "nodejs";

/** Nothing our pipeline writes comes close; a first-page PNG is tens of kilobytes. */
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

/**
 * The content type, decided by the bytes, never echoed from upstream.
 *
 * The PDF proxy learned this one the hard way: with the type copied from the store and no
 * `script-src` in the app's CSP, an upstream that answered `text/html` made this origin serve
 * markup. The pipeline writes PNG; JPEG is tolerated for older rows. Anything else is not an image
 * we are willing to serve from our own origin.
 */
function pinnedImageMime(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}

export async function GET(request: Request, ctx: { params: Promise<{ shareId: string }> }) {
  const { shareId } = await ctx.params;
  if (!shareId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const resolved = await resolveShareLink(shareId, { select: { previewImageUrl: 1, firstPagePngUrl: 1 } });
  if (!resolved || resolved.refusal) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Unconditional: `shareLinkUnlocked` answers true for a link with no password, so the gate cannot
  // be lost by forgetting the `if` — which is how it was lost on the analytics ingest once.
  if (!shareLinkUnlocked(request, shareId, resolved.link as PasswordProtectedLink)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const doc = resolved.doc as { previewImageUrl?: unknown; firstPagePngUrl?: unknown };
  const candidate =
    (typeof doc.previewImageUrl === "string" && doc.previewImageUrl.trim()) ||
    (typeof doc.firstPagePngUrl === "string" && doc.firstPagePngUrl.trim()) ||
    "";
  if (!candidate) return NextResponse.json({ error: "No preview" }, { status: 404 });

  // `fetchStoredBlob` applies the host allowlist to every hop, so a stored pointer that redirects
  // off the store is refused rather than followed.
  const upstream = await fetchStoredBlob(candidate).catch(() => null);
  if (!upstream || !upstream.ok) return NextResponse.json({ error: "No preview" }, { status: 404 });

  const declaredLength = Number(upstream.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PREVIEW_BYTES) {
    return NextResponse.json({ error: "No preview" }, { status: 404 });
  }
  const bytes = Buffer.from(await upstream.arrayBuffer());
  if (bytes.length > MAX_PREVIEW_BYTES) return NextResponse.json({ error: "No preview" }, { status: 404 });

  const mime = pinnedImageMime(bytes);
  if (!mime) return NextResponse.json({ error: "No preview" }, { status: 404 });

  const headers = new Headers();
  headers.set("content-type", mime);
  headers.set("content-length", String(bytes.length));
  // `nosniff` because the type above is ours, not the store's: a browser must not second-guess it.
  headers.set("x-content-type-options", "nosniff");
  // `private`, because these bytes are scoped to whoever got past the gate above; a shared cache is
  // keyed on the URL alone and would serve a locked link's first page to anyone who asked. Five
  // minutes is the window in which a revoked link keeps showing its cover to a browser that already
  // had it, and it matches the project twin.
  headers.set("cache-control", "private, max-age=300");

  return new Response(bytes, { status: 200, headers });
}
