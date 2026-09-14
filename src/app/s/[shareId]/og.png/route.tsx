import { ImageResponse } from "next/og";
import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveShareLink } from "@/lib/share/links";
import {
  DEFAULT_OG_SIZE,
  imageResponseFromBytes,
  mimeFromPath,
  sniffImageDims,
} from "@/lib/og/imageResponse";

export const runtime = "nodejs";

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

    let buf: Buffer;
    let mime: string;

    if (/^https?:\/\//i.test(candidate)) {
      const res = await fetch(candidate, { cache: "no-store" });
      if (!res.ok) throw new Error(`failed to fetch preview (${res.status})`);
      const arr = await res.arrayBuffer();
      buf = Buffer.from(arr);
      mime = res.headers.get("content-type")?.split(";")[0]?.trim() || mimeFromPath(candidate);
    } else {
      const abs = join(process.cwd(), candidate);
      buf = readFileSync(abs);
      mime = mimeFromPath(candidate);
    }

    return imageResponseFromBytes({
      bytes: buf,
      mime,
      alt: title,
      dims: sniffImageDims(buf) ?? DEFAULT_OG_SIZE,
      cacheControl: "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400",
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
    res.headers.set(
      "Cache-Control",
      "public, max-age=300, s-maxage=300, stale-while-revalidate=3600",
    );
    return res;
  }
}




