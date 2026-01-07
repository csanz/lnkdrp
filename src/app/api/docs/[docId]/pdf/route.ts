import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { applyTempUserHeaders, resolveActor, tryResolveUserActorFast } from "@/lib/gating/actor";

export const runtime = "nodejs";
/**
 * Return whether object id.
 */


function isObjectId(id: string) {
  return Types.ObjectId.isValid(id);
}
/**
 * Pick Header (uses get, set).
 */


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

  const actor = (await tryResolveUserActorFast(request)) ?? (await resolveActor(request));
  await connectMongo();

  const orgId = new Types.ObjectId(actor.orgId);
  const legacyUserId = new Types.ObjectId(actor.userId);
  const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
  const doc = await DocModel.findOne({
    ...(allowLegacyByUserId
      ? {
          $or: [
            { _id: new Types.ObjectId(docId), orgId, isDeleted: { $ne: true } },
            {
              _id: new Types.ObjectId(docId),
              userId: legacyUserId,
              isDeleted: { $ne: true },
              $or: [{ orgId: { $exists: false } }, { orgId: null }],
            },
          ],
        }
      : { _id: new Types.ObjectId(docId), orgId, isDeleted: { $ne: true } }),
  })
    .select({ blobUrl: 1 })
    .lean();

  const blobUrl = doc?.blobUrl ?? null;
  if (!blobUrl || typeof blobUrl !== "string") {
    return NextResponse.json({ error: "PDF not available" }, { status: 404 });
  }

  // Redirect to the blob URL so the browser downloads bytes directly (avoids double-hop proxying).
  // This keeps the owner-only authorization check here, but prevents the server from streaming
  // potentially large PDF bytes on every request.
  const res = NextResponse.redirect(blobUrl, { status: 302 });
  // Cache aggressively in the browser; URL versioning handles invalidation.
  // Use `private` because this is an authenticated owner endpoint.
  res.headers.set("cache-control", "private, max-age=31536000, immutable");
  return applyTempUserHeaders(res, actor);
}





