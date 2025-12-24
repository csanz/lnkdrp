import { ImageResponse } from "next/og";
import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
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

  await connectMongo();
  const doc = await DocModel.findOne({ shareId, isDeleted: { $ne: true } }).lean();
  if (!doc) notFound();

  const sharePasswordHash = (doc as { sharePasswordHash?: unknown }).sharePasswordHash;
  const sharePasswordSalt = (doc as { sharePasswordSalt?: unknown }).sharePasswordSalt;
  const passwordEnabled =
    typeof sharePasswordHash === "string" &&
    Boolean(sharePasswordHash) &&
    typeof sharePasswordSalt === "string" &&
    Boolean(sharePasswordSalt);

  const title =
    (doc.aiOutput &&
      typeof doc.aiOutput === "object" &&
      typeof (doc.aiOutput as { openGraph?: { title?: unknown } }).openGraph?.title ===
        "string" &&
      (doc.aiOutput as { openGraph: { title: string } }).openGraph.title) ||
    doc.title ||
    "Shared document";

  const og = (doc.aiOutput && typeof doc.aiOutput === "object"
    ? (doc.aiOutput as { openGraph?: { imageUrl?: unknown; imagePath?: unknown } }).openGraph
    : undefined) as { imageUrl?: unknown; imagePath?: unknown } | undefined;

  const candidate =
    passwordEnabled
      ? null
      : (typeof doc.previewImageUrl === "string" && doc.previewImageUrl) ||
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

