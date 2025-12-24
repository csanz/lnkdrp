import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";

export const runtime = "nodejs";

function isObjectId(id: string) {
  return Types.ObjectId.isValid(id);
}

function pickHeader(
  src: Headers,
  dst: Headers,
  name: string,
  opts?: { fallback?: string },
) {
  const v = src.get(name);
  if (typeof v === "string" && v) {
    dst.set(name, v);
    return;
  }
  if (opts?.fallback) dst.set(name, opts.fallback);
}

/**
 * Same-origin cached PDF proxy for the owner doc page.
 *
 * Why:
 * - The browser PDF viewer (iframe) will re-request the PDF on every navigation
 *   unless we provide cacheable headers.
 * - We version the URL with `?v=<uploadVersion>` in the client so replacements
 *   automatically bust the cache.
 *
 * Notes:
 * - Supports Range requests (Chrome's built-in PDF viewer uses them).
 * - Uses actor ownership checks (same as other `/api/docs/:docId` routes).
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ docId: string }> },
) {
  const { docId } = await ctx.params;
  if (!isObjectId(docId)) {
    return NextResponse.json({ error: "Invalid docId" }, { status: 400 });
  }

  const actor = await resolveActor(request);
  await connectMongo();

  const doc = await DocModel.findOne({
    _id: new Types.ObjectId(docId),
    userId: new Types.ObjectId(actor.userId),
    isDeleted: { $ne: true },
  })
    .select({ blobUrl: 1 })
    .lean();

  const blobUrl = doc?.blobUrl ?? null;
  if (!blobUrl || typeof blobUrl !== "string") {
    return NextResponse.json({ error: "PDF not available" }, { status: 404 });
  }

  const range = request.headers.get("range");
  const upstream = await fetch(blobUrl, {
    headers: range ? { range } : undefined,
    // Always fetch the current bytes server-side; the browser cache is handled
    // by our response headers + the versioned URL.
    cache: "no-store",
  });

  // Build a tight header set (avoid leaking upstream storage headers).
  const headers = new Headers();
  pickHeader(upstream.headers, headers, "content-type", { fallback: "application/pdf" });
  pickHeader(upstream.headers, headers, "content-length");
  pickHeader(upstream.headers, headers, "content-range");
  pickHeader(upstream.headers, headers, "accept-ranges");
  pickHeader(upstream.headers, headers, "etag");
  pickHeader(upstream.headers, headers, "last-modified");

  // Cache aggressively in the browser; URL versioning handles invalidation.
  // Use `private` because this is an authenticated owner endpoint.
  headers.set("cache-control", "private, max-age=31536000, immutable");

  const res = new Response(upstream.body, {
    status: upstream.status,
    headers,
  });

  return applyTempUserHeaders(res, actor);
}


