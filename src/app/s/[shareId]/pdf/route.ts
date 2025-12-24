import { NextResponse } from "next/server";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { shareAuthCookieName, shareAuthCookieValue } from "@/lib/sharePassword";

export const runtime = "nodejs";

function getCookie(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) return null;
  // Minimal cookie parsing (no decoding needed for our values).
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=") || "";
  }
  return null;
}

function pickHeader(src: Headers, dst: Headers, name: string, opts?: { fallback?: string }) {
  const v = src.get(name);
  if (typeof v === "string" && v) {
    dst.set(name, v);
    return;
  }
  if (opts?.fallback) dst.set(name, opts.fallback);
}

function safePdfFilename(input: string | null | undefined): string {
  const base = (input ?? "").toString().trim() || "document";
  const cleaned = base
    .replace(/[\/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const withExt = cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
  return withExt || "document.pdf";
}

/**
 * Same-origin PDF proxy for `/s/:shareId`.
 *
 * - Supports Range requests (PDF.js uses them).
 * - If password-protected, requires the share auth cookie.
 * - If `?download=1`, enforces `doc.shareAllowPdfDownload` and sets attachment headers.
 */
export async function GET(request: Request, ctx: { params: Promise<{ shareId: string }> }) {
  const { shareId } = await ctx.params;
  if (!shareId) return NextResponse.json({ error: "Missing shareId" }, { status: 400 });

  const url = new URL(request.url);
  const wantsDownload = url.searchParams.get("download") === "1";

  await connectMongo();
  const doc = await DocModel.findOne({ shareId, isDeleted: { $ne: true } })
    .select({
      blobUrl: 1,
      title: 1,
      fileName: 1,
      shareAllowPdfDownload: 1,
      sharePasswordHash: 1,
      sharePasswordSalt: 1,
    })
    .lean();

  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const blobUrl = (doc as { blobUrl?: unknown }).blobUrl;
  if (typeof blobUrl !== "string" || !blobUrl) {
    return NextResponse.json({ error: "PDF not available" }, { status: 404 });
  }

  const sharePasswordHash = (doc as { sharePasswordHash?: unknown }).sharePasswordHash;
  const sharePasswordSalt = (doc as { sharePasswordSalt?: unknown }).sharePasswordSalt;
  const passwordEnabled =
    typeof sharePasswordHash === "string" &&
    Boolean(sharePasswordHash) &&
    typeof sharePasswordSalt === "string" &&
    Boolean(sharePasswordSalt);

  if (passwordEnabled) {
    const cookieName = shareAuthCookieName(shareId);
    const cookie = getCookie(request, cookieName) ?? "";
    const expected = shareAuthCookieValue({ shareId, sharePasswordHash: sharePasswordHash as string });
    if (!cookie || cookie !== expected) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  if (wantsDownload && !Boolean((doc as { shareAllowPdfDownload?: unknown }).shareAllowPdfDownload)) {
    return new Response("Download disabled", { status: 403 });
  }

  const range = request.headers.get("range");
  const upstream = await fetch(blobUrl, {
    headers: range ? { range } : undefined,
    cache: "no-store",
  });

  const headers = new Headers();
  pickHeader(upstream.headers, headers, "content-type", { fallback: "application/pdf" });
  pickHeader(upstream.headers, headers, "content-length");
  pickHeader(upstream.headers, headers, "content-range");
  pickHeader(upstream.headers, headers, "accept-ranges");
  pickHeader(upstream.headers, headers, "etag");
  pickHeader(upstream.headers, headers, "last-modified");

  // Share pages can be password protected; keep caching private.
  headers.set("cache-control", "private, max-age=3600");

  const filename = safePdfFilename(
    (doc as { fileName?: unknown }).fileName as string | null | undefined ??
      ((doc as { title?: unknown }).title as string | null | undefined),
  );
  headers.set("content-disposition", `${wantsDownload ? "attachment" : "inline"}; filename="${filename}"`);

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}


