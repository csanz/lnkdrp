import { ImageResponse } from "next/og";
import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { isBlobStoreHost } from "@/lib/blob/serverClientUploadRoute";
import { resolveShareLink } from "@/lib/share/links";
import {
  DEFAULT_OG_SIZE,
  imageResponseFromBytes,
  mimeFromPath,
  sniffImageDims,
} from "@/lib/og/imageResponse";

export const runtime = "nodejs";

/**
 * Vercel Blob's public CDN, where the upload pipeline writes every preview
 * (`<storeId>.public.blob.vercel-storage.com`, and the bare host on older rows).
 */
const VERCEL_BLOB_HOST = "blob.vercel-storage.com";

/**
 * Which stored preview value this route is willing to go and *dereference*.
 *
 * `previewImageUrl` reaches this file as owner-controlled text: `PATCH /api/docs/:docId` stores
 * whatever string the body carries, with no validation. This route is unauthenticated — anyone who
 * knows a slug can `GET /s/<slug>/og.png` — so whatever that field says, the server does, on demand.
 *
 * It used to say two dangerous things:
 *
 *  - anything matching `^https?://` was `fetch`ed, so `http://169.254.169.254/latest/meta-data/`
 *    or any hostname inside the deployment's network turned this into an SSRF probe that an
 *    attacker could time from the outside;
 *  - anything *else* was `readFileSync(join(process.cwd(), value))`, so `../../../../etc/passwd`
 *    (or `/dev/zero`) was an arbitrary filesystem read. That branch existed for
 *    `aiOutput.openGraph.imagePath`, a field nothing in this repo has ever written — its only
 *    reachable input was a value someone typed into the API — so it is gone entirely rather than
 *    path-sanitised.
 *
 * What remains is an allowlist of the blob CDN previews actually live on: our own configured store
 * (`isBlobStoreHost`, the same authority the upload routes use), plus the Vercel Blob public host
 * family so rows written before the store id was pinned keep rendering. Another tenant's blob store
 * is still a public, read-only, credential-free CDN, so pointing at one buys nothing; an internal
 * address or a local path is what this refuses.
 *
 * Returning null is deliberately *not* an error: the caller falls through to the text card it
 * already renders for a document with no preview, so a legitimate document with an unusual URL
 * still unfurls with its title instead of 404ing.
 */
function previewFetchUrl(candidate: string): URL | null {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    // Not absolute at all — a relative path, which only the removed filesystem branch ever wanted.
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (isBlobStoreHost(host)) return url;
  return host === VERCEL_BLOB_HOST || host.endsWith(`.${VERCEL_BLOB_HOST}`) ? url : null;
}

/**
 * `private`, never `public` — the same rule the recipient history endpoint states at
 * `/s/[shareId]/changes/route.ts`. The refusal and password checks below run per request, but a
 * shared/CDN cache is keyed on the URL alone and never re-asks: the previous
 * `public, s-maxage=3600, stale-while-revalidate=86400` meant that once any unfurl bot had warmed
 * an edge entry, the document's title and a picture of its first page kept being served for up to
 * 25 hours after the owner disabled, expired, archived or password-protected the link — i.e. the
 * revocation controls silently stopped applying to the one surface that needs no cookie to reach.
 * The short `max-age` still absorbs a single client's repeated fetches of the same preview.
 */
const OG_CACHE_CONTROL = "private, max-age=300";

/**
 * Dynamic OG image route for a share page.
 *
 * Prefers a doc's server-generated preview image when available; otherwise
 * falls back to a simple text card.
 */
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ shareId: string }> },
) {
  const { shareId } = await context.params;
  if (!shareId) notFound();

  // The OG image is the document's, never the link's: labels and audiences stay private
  // (docs/prds/lnkdrp-multi-links.md). A refused link has no preview at all.
  const resolved = await resolveShareLink(shareId, {
    select: { title: 1, aiOutput: 1, previewImageUrl: 1, firstPagePngUrl: 1 } as Record<string, 1>,
  });
  if (!resolved || resolved.refusal) notFound();
  // A password-protected link has no preview either. This image is rendered from the document's
  // title and its first page, which is exactly what the password withholds — and an unfurl fetches
  // it with no cookie, so the gate upstream never sees the request.
  if (resolved.link.passwordHash && resolved.link.passwordSalt) notFound();
  const doc = resolved.doc as {
    title?: unknown;
    aiOutput?: unknown;
    previewImageUrl?: unknown;
    firstPagePngUrl?: unknown;
  };

  const ogTitle =
    doc.aiOutput &&
    typeof doc.aiOutput === "object" &&
    typeof (doc.aiOutput as { openGraph?: { title?: unknown } }).openGraph?.title === "string"
      ? (doc.aiOutput as { openGraph: { title: string } }).openGraph.title
      : "";
  const title = ogTitle || (typeof doc.title === "string" ? doc.title : "") || "Shared document";

  const og = (doc.aiOutput && typeof doc.aiOutput === "object"
    ? (doc.aiOutput as { openGraph?: { imageUrl?: unknown; imagePath?: unknown } }).openGraph
    : undefined) as { imageUrl?: unknown; imagePath?: unknown } | undefined;

  const candidate =
    (typeof doc.previewImageUrl === "string" && doc.previewImageUrl) ||
    (typeof doc.firstPagePngUrl === "string" && doc.firstPagePngUrl) ||
    (typeof og?.imageUrl === "string" && og.imageUrl) ||
    (typeof og?.imagePath === "string" && og.imagePath) ||
    null;

  try {
    if (!candidate) throw new Error("no image candidate");
    const previewUrl = previewFetchUrl(candidate);
    // Not a preview we are allowed to dereference: fall through to the text card (see
    // `previewFetchUrl` for what used to happen instead).
    if (!previewUrl) throw new Error("preview URL is not on the blob store");

    const res = await fetch(previewUrl, { cache: "no-store" });
    if (!res.ok) throw new Error(`failed to fetch preview (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || mimeFromPath(candidate);

    return imageResponseFromBytes({
      bytes: buf,
      mime,
      alt: title,
      dims: sniffImageDims(buf) ?? DEFAULT_OG_SIZE,
      cacheControl: OG_CACHE_CONTROL,
    });
  } catch {
    const res = new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 64,
            fontSize: 56,
            fontWeight: 700,
            background: "white",
            color: "black",
            textAlign: "center",
            lineHeight: 1.1,
          }}
        >
          {title}
        </div>
      ),
      DEFAULT_OG_SIZE,
    );
    // The text card is the document's real title, so it is revocable too — same header.
    res.headers.set("Cache-Control", OG_CACHE_CONTROL);
    return res;
  }
}




