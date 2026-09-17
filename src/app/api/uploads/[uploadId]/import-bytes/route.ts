/**
 * API route for `/api/uploads/:uploadId/import-bytes`.
 *
 * Attaches a PDF to an existing Upload from bytes sent directly in the request, instead of a URL
 * the server has to fetch (`import-url`, its sibling). Exists for a caller that has the file itself
 * but nowhere public to point a URL at — most concretely, the MCP tools (`lnkdrp_share_pdf` /
 * `lnkdrp_replace_pdf`), whose only path in used to be "publish the file somewhere on the open
 * internet first" (mt_bJwX4CtmhU).
 *
 * Body-size ceiling, and why it's small: Vercel Functions cap a request body at 4.5MB regardless
 * of content type. Base64 inflates by ~4/3, so the encoded body alone eats most of that budget
 * before the JSON envelope or headers are counted. 3MB decoded (§ MAX_DECODED_BYTES) keeps real
 * margin under the hard platform ceiling; it is not a product decision to keep files small, it is
 * the honest limit of "bytes through a serverless function body." A file too big for this still
 * needs `import-url` (a URL the server can fetch) — there is no direct-to-Blob path for a caller
 * that only speaks JSON tool calls, and building one would mean either reverse-engineering Vercel
 * Blob's client-token wire protocol for third-party callers (undocumented, SDK-only) or handing
 * the MCP server its own Blob credential and re-implementing this route's validation a second time
 * outside the app of record — both worse than a documented ceiling.
 *
 * Everything past "how the bytes arrived" is identical to `import-url`: same ownership check, same
 * PDF-signature validation (never trust a filename or declared type alone), same Blob pathname
 * convention, same Upload fields, same activity type (labelled "from a file" instead of "from a
 * URL" — see `src/lib/activity/labels.ts`).
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { put } from "@vercel/blob";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { UploadModel } from "@/lib/models/Upload";
import { buildDocBlobPathname } from "@/lib/blob/clientUpload";
import { looksLikePdfBytes, sanitizeFileName, PDF_ONLY_ERROR_MESSAGE, UNSUPPORTED_FILE_TYPE_CODE } from "@/lib/blob/serverClientUploadRoute";
import { debugError, debugLog } from "@/lib/debug";
import { actorRateLimitResponse } from "@/lib/gating/actorRateLimit";
import { applyTempUserHeaders, resolveActor, type Actor } from "@/lib/gating/actor";
import { forbidUnlessOrgRole } from "@/lib/orgs/requireOrgEditor";
import { recordActivity } from "@/lib/activity/log";
import { abandonUploadIfImportFailed } from "@/lib/uploads/abandonUpload";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Decoded-size ceiling — see the module doc for why this is well under Vercel's 4.5MB request-body
 * limit rather than the 25MB `import-url` allows for a server-side fetch (a fetch's response body
 * is read directly by this same function; a base64 request body first has to arrive intact).
 */
const MAX_DECODED_BYTES = 3 * 1024 * 1024; // 3MB
/** `MAX_DECODED_BYTES` as base64 text length, for a fast reject before decoding. */
const MAX_BASE64_CHARS = Math.ceil(MAX_DECODED_BYTES / 3) * 4 + 4;

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * Import a PDF from inline base64 content into an existing upload.
 *
 * Body: `{ contentBase64: string, fileName?: string }`.
 */
async function importBytes(request: Request, ctx: { params: Promise<{ uploadId: string }> }, seen: { actor: Actor | null }) {
  let actor: Actor | null = null;
  try {
    const { uploadId } = await ctx.params;
    actor = await resolveActor(request);
    seen.actor = actor;
    // Viewers must not import files (creates uploads + owner-billed processing) — same rule as import-url.
    const forbidden = await forbidUnlessOrgRole(actor);
    if (forbidden) return forbidden;
    if (!Types.ObjectId.isValid(uploadId)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid uploadId" }, { status: 400 }), actor);
    }

    const body = (await request.json().catch(() => ({}))) as { contentBase64?: unknown; fileName?: unknown };
    const contentBase64 = (asString(body.contentBase64) ?? "").trim();
    if (!contentBase64) {
      return applyTempUserHeaders(NextResponse.json({ error: "Missing contentBase64" }, { status: 400 }), actor);
    }
    if (contentBase64.length > MAX_BASE64_CHARS) {
      return applyTempUserHeaders(
        NextResponse.json({ error: `PDF is too large (max ${Math.floor(MAX_DECODED_BYTES / (1024 * 1024))}MB for inline upload; use a URL instead for anything larger)` }, { status: 400 }),
        actor,
      );
    }

    let buf: Buffer;
    try {
      buf = Buffer.from(contentBase64, "base64");
    } catch {
      return applyTempUserHeaders(NextResponse.json({ error: "contentBase64 is not valid base64" }, { status: 400 }), actor);
    }
    const sizeBytes = buf.byteLength;
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      return applyTempUserHeaders(NextResponse.json({ error: "Empty PDF" }, { status: 400 }), actor);
    }
    if (sizeBytes > MAX_DECODED_BYTES) {
      return applyTempUserHeaders(
        NextResponse.json({ error: `PDF is too large (max ${Math.floor(MAX_DECODED_BYTES / (1024 * 1024))}MB for inline upload; use a URL instead for anything larger)` }, { status: 400 }),
        actor,
      );
    }

    await connectMongo();

    // Authorization: upload must belong to the actor — same rule as import-url.
    const upload = await UploadModel.findOne({
      _id: new Types.ObjectId(uploadId),
      userId: new Types.ObjectId(actor.userId),
      isDeleted: { $ne: true },
    });
    if (!upload) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    const docId = upload.docId ? String(upload.docId) : "";
    if (!docId) {
      return applyTempUserHeaders(NextResponse.json({ error: "Upload missing docId" }, { status: 400 }), actor);
    }

    // Documents are PDF-only: the byte signature is the real gate, not the caller-supplied name.
    if (!looksLikePdfBytes(buf)) {
      debugLog(1, "[import-bytes] rejected non-PDF content", { uploadId, sizeBytes });
      return applyTempUserHeaders(
        NextResponse.json({ error: PDF_ONLY_ERROR_MESSAGE, code: UNSUPPORTED_FILE_TYPE_CODE }, { status: 415 }),
        actor,
      );
    }

    const fileName = sanitizeFileName(asString(body.fileName) ?? "document.pdf");
    const pathname = buildDocBlobPathname({ docId, uploadId, fileName });

    debugLog(1, "[import-bytes] uploading to blob", { uploadId, sizeBytes });
    const blob = await put(pathname, buf, {
      access: "public",
      contentType: "application/pdf",
      addRandomSuffix: false,
    });

    await UploadModel.findByIdAndUpdate(uploadId, {
      status: "uploaded",
      originalFileName: fileName,
      contentType: "application/pdf",
      sizeBytes,
      blobUrl: blob.url,
      blobPathname: blob.pathname,
      metadata: { size: sizeBytes },
      error: null,
    });

    // Activity (best-effort, after the primary write). Reuses `doc.imported_url`'s type — the
    // event is the same fact ("a file landed on this upload") with a different transport — and
    // `via: "bytes"` in meta is what tells the label "from a file" instead of "from a URL".
    const activityDoc = await DocModel.findById(docId).select({ orgId: 1, title: 1 }).lean().catch(() => null);
    const activityDocOrgId =
      activityDoc && (activityDoc as { orgId?: unknown }).orgId ? String((activityDoc as { orgId?: unknown }).orgId) : null;
    void recordActivity({
      orgId: activityDocOrgId ?? actor.orgId,
      userId: actor.userId,
      actorKind: actor.kind,
      type: "doc.imported_url",
      docId,
      uploadId,
      title:
        activityDoc && typeof (activityDoc as { title?: unknown }).title === "string"
          ? (activityDoc as { title: string }).title
          : null,
      meta: {
        via: "bytes",
        fileName,
        sizeBytes,
        version: Number.isFinite(upload.version) ? Number(upload.version) : null,
      },
      request,
    });

    return applyTempUserHeaders(NextResponse.json({ ok: true }), actor);
  } catch (err) {
    const limited = actorRateLimitResponse(err);
    if (limited) return limited;
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[import-bytes] failed", { message });
    const res = NextResponse.json({ error: message }, { status: 400 });
    return actor ? applyTempUserHeaders(res, actor) : res;
  }
}

/**
 * `POST` — imports the file, and when the import fails abandons the upload so its document goes
 * back to its last good version instead of sitting in `preparing` forever (see abandonUpload).
 */
export async function POST(request: Request, ctx: { params: Promise<{ uploadId: string }> }) {
  const seen: { actor: Actor | null } = { actor: null };
  const res = await importBytes(request, ctx, seen);
  if (!res.ok) await abandonUploadIfImportFailed(res, (await ctx.params).uploadId, seen.actor);
  return res;
}
