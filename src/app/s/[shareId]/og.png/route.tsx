import { ImageResponse } from "next/og";
import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { resolveShareLink } from "@/lib/share/links";
import { fetchStoredBlob } from "@/lib/blob/fetchStoredBlob";
import {
  DEFAULT_OG_SIZE,
  imageResponseFromBytes,
  mimeFromPath,
  sniffImageDims,
} from "@/lib/og/imageResponse";

export const runtime = "nodejs";



/**
 * The revocation window, in seconds, that a shared cache may keep serving this image for.
 *
 * This number is the entire trade this header makes. Read `OG_CACHE_CONTROL` before changing it.
 */
const OG_SHARED_CACHE_SECONDS = 60;

/**
 * A bounded shared cache — deliberately neither of the two headers this route has worn before.
 *
 * This is the one share surface that is fetched with no cookie and no viewer: unfurl bots. It is
 * therefore both the surface where revocation is easiest to lose *and* the surface with the worst
 * fan-out, and the two previous headers each fixed one of those by giving up the other.
 *
 *  - `public, s-maxage=3600, stale-while-revalidate=86400` lost revocation. A shared cache is keyed
 *    on the URL alone and never re-asks, so once any bot had warmed an edge entry the document's
 *    title and a picture of its first page kept being served for up to 25 hours after the owner
 *    disabled, expired, archived or password-protected the link. `stale-while-revalidate` was the
 *    worse half: it exists precisely to keep serving an entry the cache already knows is expired.
 *  - `private, max-age=300` fixed that by banning shared storage outright, and paid for it at the
 *    origin. `private` means no edge or proxy may store the bytes, so *every* unfurl becomes a cold
 *    render here: `resolveShareLink`, a server-side blob fetch, and a satori `ImageResponse`. Bots
 *    re-fetch per channel, per recipient, per re-share, so one link pasted into a large Slack
 *    workspace turns what used to be free CDN reads into a burst of serverless invocations.
 *
 * `public` is correct on the *content*: this image is scoped to the link, not to the viewer. There
 * is no cookie, no `Vary`, and no per-recipient variation — everyone who may see this link sees the
 * identical bytes, which is exactly the case a URL-keyed shared cache is built for. The only thing
 * `private` was ever buying was freshness after a revoke, and `s-maxage` buys that directly, in
 * seconds, instead of by forbidding caching.
 *
 * Why 60s, and why nothing longer: the load this header exists to absorb is a *burst*. A link
 * posted once fans out to many unfurl bots within seconds of the post, and a minute of shared
 * caching collapses that burst into a single origin render. A re-share hours later is a cold render
 * under any window we would be willing to accept, so raising 60s to an hour buys almost no extra
 * hit rate while multiplying the revocation window sixtyfold. One minute of stale exposure after an
 * owner revokes a link is under the time it takes them to check that the revoke worked; an hour is
 * not, and a day certainly is not.
 *
 * `stale-while-revalidate` is absent on purpose and must stay absent — it re-opens the exact hole
 * above by licensing a cache to serve an expired entry. `stale-if-error` is the same hazard wearing
 * a different name; do not add it either. `max-age=0` keeps a client that already has the image
 * from holding it privately past the revoke: its re-ask lands on the edge, not on us.
 *
 * The gates themselves are untouched and still run per request: `resolveShareLink`'s refusal and
 * the password check below both `notFound()` on every request that actually reaches this function,
 * and those 404s do not carry this header, so nothing caches a refusal either.
 */
const OG_CACHE_CONTROL = `public, max-age=0, s-maxage=${OG_SHARED_CACHE_SECONDS}`;

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
    // Not a preview we are allowed to dereference, or one that redirects off the store: fall
    // through to the text card. `fetchStoredBlob` re-applies the allowlist to every hop, because
    // a check that only sees the first URL says nothing about where it leads.
    const res = await fetchStoredBlob(candidate);
    if (!res) throw new Error("preview URL is not on the blob store");
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




