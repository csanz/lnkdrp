import { NextResponse } from "next/server";
import { isBlobStoreUrl } from "@/lib/blob/serverClientUploadRoute";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { buildDocMatch } from "@/lib/docs/docMatch";
import { lockedHomeExclusionFor } from "@/lib/projects/lockScope";
import { UploadModel } from "@/lib/models/Upload";
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
  const lockedExclusion = await lockedHomeExclusionFor(orgId, actor.userId, request);
  const doc = await DocModel.findOne(buildDocMatch(new Types.ObjectId(docId), orgId, legacyUserId, allowLegacyByUserId, lockedExclusion))
    .select({ blobUrl: 1 })
    .lean();

  const docBlobUrl = doc?.blobUrl ?? null;
  if (!docBlobUrl || typeof docBlobUrl !== "string") {
    return NextResponse.json({ error: "PDF not available" }, { status: 404 });
  }

  /**
   * The cache key must name the bytes it caches.
   *
   * The client versions this URL with `?v=<currentUploadId>`, and the upload route points the
   * document at a new upload the moment it is created, before processing has written that
   * upload's blob. For those seconds the page asked `?v=<new id>` and this route answered with
   * a redirect to the *previous* version's blob, marked immutable for a year. Chrome kept it:
   * the header said v3, the compare showed v3, the viewer showed v2 until the cache was cleared.
   *
   * So when `v` names one of this document's uploads, the redirect goes to that upload's own
   * blob and is cacheable only once that blob exists. Anything else (`v=0` before the doc has
   * loaded, an id this route cannot resolve, an upload still processing) is answered with the
   * document's current blob and `no-store`, so nothing wrong is ever pinned.
   */
  const v = new URL(request.url).searchParams.get("v") ?? "";
  let target = docBlobUrl;
  let cacheable = false;
  if (v && isObjectId(v)) {
    const upload = (await UploadModel.findOne({ _id: new Types.ObjectId(v), docId: new Types.ObjectId(docId) }).select({ blobUrl: 1 }).lean()) as { blobUrl?: string } | null;
    if (upload && typeof upload.blobUrl === "string" && upload.blobUrl) {
      target = upload.blobUrl;
      cacheable = true;
    }
  }

  // Only our own store is ever redirected to: a stored URL that points elsewhere is answered as
  // no PDF, the same as a missing one, rather than sent to the browser as an open redirect.
  if (!isBlobStoreUrl(target)) {
    return applyTempUserHeaders(NextResponse.json({ error: "PDF not available" }, { status: 404 }), actor);
  }

  // Redirect to the blob URL so the browser downloads bytes directly (avoids double-hop proxying).
  // This keeps the owner-only authorization check here, but prevents the server from streaming
  // potentially large PDF bytes on every request.
  const res = NextResponse.redirect(target, { status: 302 });
  // `private` because this is an authenticated owner endpoint; immutable only when the URL names
  // the exact upload whose bytes it redirects to (see above).
  res.headers.set("cache-control", cacheable ? "private, max-age=31536000, immutable" : "private, no-store");
  return applyTempUserHeaders(res, actor);
}
