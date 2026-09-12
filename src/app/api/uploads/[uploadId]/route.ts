import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { UploadModel } from "@/lib/models/Upload";
import { debugError, debugLog } from "@/lib/debug";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { DocModel } from "@/lib/models/Doc";
import {
  isBlobPathnameForUpload,
  isBlobUrlForUpload,
  isPdfUploadMeta,
  PDF_ONLY_ERROR_MESSAGE,
  UNSUPPORTED_FILE_TYPE_CODE,
} from "@/lib/blob/serverClientUploadRoute";
import { recordActivity } from "@/lib/activity/log";

export const runtime = "nodejs";
/**
 * Header (uses get, toLowerCase).
 */


function header(request: Request, name: string) {
  return request.headers.get(name) ?? request.headers.get(name.toLowerCase());
}

/**
 * Upload status + metadata.
 *
 * Route: GET /api/uploads/:uploadId
 *
 * Note: supports capability access via `x-upload-secret` (used by request upload links),
 * otherwise requires an authenticated actor and ownership.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ uploadId: string }> },
) {
  try {
    const { uploadId } = await ctx.params;
    if (!Types.ObjectId.isValid(uploadId)) {
      return NextResponse.json({ error: "Invalid uploadId" }, { status: 400 });
    }

    debugLog(1, "[api/uploads/:uploadId] GET", { uploadId });

    await connectMongo();

    const uploadSecret = header(request, "x-upload-secret");
    if (typeof uploadSecret === "string" && uploadSecret.trim()) {
      const upload = await UploadModel.findOne({
        _id: new Types.ObjectId(uploadId),
        uploadSecret: uploadSecret.trim(),
        isDeleted: { $ne: true },
      }).lean();
      if (!upload) return NextResponse.json({ error: "Not found" }, { status: 404 });

      const doc = upload.docId
        ? await DocModel.findOne({ _id: upload.docId, isDeleted: { $ne: true } })
            .select({ status: 1 })
            .lean()
        : null;

      return NextResponse.json({
        upload: {
          id: String(upload._id),
          docId: upload.docId ? String(upload.docId) : null,
          status: upload.status ?? null,
          version: typeof (upload as any).version === "number" ? (upload as any).version : null,
        },
        doc: {
          id: upload.docId ? String(upload.docId) : null,
          status: doc?.status ?? null,
        },
      });
    }

    const actor = await resolveActor(request);
    const upload = await UploadModel.findOne({
      _id: new Types.ObjectId(uploadId),
      userId: new Types.ObjectId(actor.userId),
      isDeleted: { $ne: true },
    }).lean();
    if (!upload) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const doc = upload.docId
      ? await DocModel.findOne({
          _id: upload.docId,
          userId: new Types.ObjectId(actor.userId),
          isDeleted: { $ne: true },
        })
          .select({ status: 1 })
          .lean()
      : null;

    return applyTempUserHeaders(
      NextResponse.json({
        upload: {
          id: String(upload._id),
          docId: upload.docId ? String(upload.docId) : null,
          status: upload.status ?? null,
          version: typeof (upload as any).version === "number" ? (upload as any).version : null,
        },
        doc: {
          id: upload.docId ? String(upload.docId) : null,
          status: doc?.status ?? null,
        },
      }),
      actor,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/uploads/:uploadId] GET failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/**
 * Statuses a client is allowed to set. Pipeline-owned states (`processing`, `completed`)
 * are only ever written by the process route.
 */
const CLIENT_SETTABLE_STATUSES = new Set(["uploaded", "failed"]);

/**
 * Build the sanitized `$set` update from a client PATCH body.
 *
 * Blob URLs/pathnames are only accepted when they point at our Blob store *and* live under
 * this upload's own folder (`docs/{docId}/uploads/{uploadId}/`), so a client cannot attach
 * an arbitrary remote file (or another upload's file) to this record.
 *
 * Returns `{ error }` on validation failures.
 */
function buildPatchUpdate(
  body: Partial<{
    status: string;
    blobUrl: string;
    blobPathname: string;
    previewImageUrl: string | null;
    rawExtractedText: string | null;
    error: unknown;
    metadata: { pages?: number; size?: number; checksum?: string };
  }>,
  scope: { docId: string; uploadId: string },
): { update: Record<string, unknown> } | { error: string } {
  const update: Record<string, unknown> = {};
  if (typeof body.status === "string") {
    if (!CLIENT_SETTABLE_STATUSES.has(body.status)) {
      return { error: `Invalid status (allowed: ${[...CLIENT_SETTABLE_STATUSES].join(", ")})` };
    }
    update.status = body.status;
  }
  if (typeof body.blobUrl === "string") {
    if (!scope.docId || !isBlobUrlForUpload(body.blobUrl, scope)) {
      return { error: "Invalid blobUrl (must point at this upload's blob folder)" };
    }
    update.blobUrl = body.blobUrl;
  }
  if (typeof body.blobPathname === "string") {
    if (!scope.docId || !isBlobPathnameForUpload(body.blobPathname, scope)) {
      return { error: "Invalid blobPathname (must be under this upload's blob folder)" };
    }
    update.blobPathname = body.blobPathname;
  }
  if (typeof body.previewImageUrl === "string" || body.previewImageUrl === null) {
    if (typeof body.previewImageUrl === "string" && (!scope.docId || !isBlobUrlForUpload(body.previewImageUrl, scope))) {
      return { error: "Invalid previewImageUrl (must point at this upload's blob folder)" };
    }
    update.previewImageUrl = body.previewImageUrl;
    // keep compat field in sync
    update.firstPagePngUrl = body.previewImageUrl;
  }
  if (typeof body.rawExtractedText === "string" || body.rawExtractedText === null) {
    update.rawExtractedText = body.rawExtractedText;
    // keep compat field in sync
    update.pdfText = body.rawExtractedText;
  }
  if (body.error !== undefined) update.error = body.error;
  if (body.metadata && typeof body.metadata === "object") update.metadata = body.metadata;
  return { update };
}

/**
 * Return whether an upload being marked `uploaded` is a PDF.
 *
 * Uses the metadata stored at creation time (`contentType` / `originalFileName`); when neither was
 * recorded, falls back to the extension of the blob pathname being attached. Documents are PDF-only.
 */
function isPdfUploadRecord(
  stored: { contentType?: unknown; originalFileName?: unknown },
  update: Record<string, unknown>,
): boolean {
  const contentType = typeof stored.contentType === "string" ? stored.contentType : "";
  const originalFileName = typeof stored.originalFileName === "string" ? stored.originalFileName : "";
  const blobPathname = typeof update.blobPathname === "string" ? update.blobPathname : "";
  const blobName = blobPathname.split("/").pop() ?? "";
  if (blobName && !/\.pdf$/i.test(blobName)) return false;
  const hasStoredMeta = Boolean(contentType.trim() || originalFileName.trim());
  return hasStoredMeta ? isPdfUploadMeta({ contentType, fileName: originalFileName }) : /\.pdf$/i.test(blobName);
}

/**
 * Record `upload.completed` once an upload transitions to `uploaded` (best-effort; never throws).
 */
async function logUploadCompleted(params: {
  request: Request;
  upload: {
    _id: unknown;
    docId?: unknown;
    userId?: unknown;
    orgId?: unknown;
    version?: unknown;
    originalFileName?: unknown;
    sizeBytes?: unknown;
    metadata?: unknown;
  };
  actorKind: "user" | "temp" | "secret";
  fallbackOrgId?: string | null;
}): Promise<void> {
  const { request, upload, actorKind, fallbackOrgId } = params;
  const docId = upload.docId ? String(upload.docId) : null;
  const doc = docId
    ? await DocModel.findById(docId).select({ orgId: 1, title: 1 }).lean().catch(() => null)
    : null;
  const docOrgId = doc && (doc as { orgId?: unknown }).orgId ? String((doc as { orgId?: unknown }).orgId) : null;
  const orgId = docOrgId ?? (upload.orgId ? String(upload.orgId) : null) ?? fallbackOrgId ?? null;
  if (!orgId) return;
  const meta = upload.metadata && typeof upload.metadata === "object" ? (upload.metadata as { size?: unknown }) : null;
  const sizeBytes =
    typeof upload.sizeBytes === "number" ? upload.sizeBytes : typeof meta?.size === "number" ? meta.size : null;
  void recordActivity({
    orgId,
    userId: upload.userId ? String(upload.userId) : null,
    actorKind,
    type: "upload.completed",
    docId,
    uploadId: String(upload._id),
    title: doc && typeof (doc as { title?: unknown }).title === "string" ? (doc as { title: string }).title : null,
    meta: {
      fileName: typeof upload.originalFileName === "string" ? upload.originalFileName : null,
      sizeBytes,
      version: typeof upload.version === "number" ? upload.version : null,
    },
    request,
  });
}

/**
 * Handle PATCH requests.
 */


export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ uploadId: string }> },
) {
  try {
    const { uploadId } = await ctx.params;
    if (!Types.ObjectId.isValid(uploadId)) {
      return NextResponse.json({ error: "Invalid uploadId" }, { status: 400 });
    }

    debugLog(1, "[api/uploads/:uploadId] PATCH", { uploadId });
    const body = (await request.json().catch(() => ({}))) as Partial<{
      status: string;
      blobUrl: string;
      blobPathname: string;
      previewImageUrl: string | null;
      rawExtractedText: string | null;
      error: unknown;
      metadata: { pages?: number; size?: number; checksum?: string };
    }>;

    await connectMongo();

    const uploadSecret = header(request, "x-upload-secret");
    if (typeof uploadSecret === "string" && uploadSecret.trim()) {
      const trimmed = uploadSecret.trim();
      debugLog(2, "[api/uploads/:uploadId] PATCH secret-auth", {
        uploadId,
        hasSecret: true,
        secretLen: trimmed.length,
      });

      // Debug-friendly behavior: distinguish between missing upload vs secret mismatch.
      // (This route is used by capability flows; returning a clearer error helps diagnose issues.)
      const exists = await UploadModel.findOne({
        _id: new Types.ObjectId(uploadId),
        isDeleted: { $ne: true },
      })
        .select({ _id: 1, uploadSecret: 1, docId: 1, contentType: 1, originalFileName: 1 })
        .lean();
      if (!exists) return NextResponse.json({ error: "Not found" }, { status: 404 });

      const stored = typeof (exists as any).uploadSecret === "string" ? String((exists as any).uploadSecret).trim() : "";
      if (!stored) {
        return NextResponse.json({ error: "UPLOAD_SECRET_NOT_ENABLED" }, { status: 403 });
      }
      if (stored !== trimmed) {
        return NextResponse.json({ error: "UPLOAD_SECRET_MISMATCH" }, { status: 403 });
      }

      const built = buildPatchUpdate(body, { docId: exists.docId ? String(exists.docId) : "", uploadId });
      if ("error" in built) return NextResponse.json({ error: built.error }, { status: 400 });
      const update = built.update;
      if (update.status === "uploaded" && !isPdfUploadRecord(exists, update)) {
        debugLog(1, "[api/uploads/:uploadId] PATCH unsupported file type (secret)", { uploadId });
        return NextResponse.json({ error: PDF_ONLY_ERROR_MESSAGE, code: UNSUPPORTED_FILE_TYPE_CODE }, { status: 415 });
      }
      if ("previewImageUrl" in update) {
        debugLog(1, "[api/uploads/:uploadId] PATCH previewImageUrl (secret)", {
          uploadId,
          hasPreview: Boolean(update.previewImageUrl),
        });
      }

      const upload = await UploadModel.findOneAndUpdate(
        { _id: new Types.ObjectId(uploadId), uploadSecret: trimmed, isDeleted: { $ne: true } },
        update,
        { new: true },
      ).lean();
      if (!upload) return NextResponse.json({ error: "Not found" }, { status: 404 });

      if (update.status === "uploaded") {
        // Link recipients act inside the owner's workspace; attribute the row to the owner as "secret".
        void logUploadCompleted({ request, upload, actorKind: "secret" });
      }

      return NextResponse.json({
        upload: {
          id: String(upload._id),
          docId: upload.docId ? String(upload.docId) : null,
          status: upload.status ?? null,
          blobUrl: upload.blobUrl ?? null,
          blobPathname: upload.blobPathname ?? null,
          previewImageUrl: upload.previewImageUrl ?? upload.firstPagePngUrl ?? null,
          rawExtractedText: upload.rawExtractedText ?? upload.pdfText ?? null,
        },
      });
    }

    const actor = await resolveActor(request);
    const owned = await UploadModel.findOne({
      _id: new Types.ObjectId(uploadId),
      userId: new Types.ObjectId(actor.userId),
      isDeleted: { $ne: true },
    })
      .select({ _id: 1, docId: 1, contentType: 1, originalFileName: 1 })
      .lean();
    if (!owned) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    const built = buildPatchUpdate(body, { docId: owned.docId ? String(owned.docId) : "", uploadId });
    if ("error" in built) {
      return applyTempUserHeaders(NextResponse.json({ error: built.error }, { status: 400 }), actor);
    }
    const update = built.update;
    if (update.status === "uploaded" && !isPdfUploadRecord(owned, update)) {
      debugLog(1, "[api/uploads/:uploadId] PATCH unsupported file type (actor)", { uploadId });
      return applyTempUserHeaders(
        NextResponse.json({ error: PDF_ONLY_ERROR_MESSAGE, code: UNSUPPORTED_FILE_TYPE_CODE }, { status: 415 }),
        actor,
      );
    }
    if ("previewImageUrl" in update) {
      debugLog(1, "[api/uploads/:uploadId] PATCH previewImageUrl (actor)", {
        uploadId,
        hasPreview: Boolean(update.previewImageUrl),
      });
    }
    const upload = await UploadModel.findOneAndUpdate(
      { _id: new Types.ObjectId(uploadId), userId: new Types.ObjectId(actor.userId), isDeleted: { $ne: true } },
      update,
      { new: true },
    ).lean();
    if (!upload) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (update.status === "uploaded") {
      void logUploadCompleted({ request, upload, actorKind: actor.kind, fallbackOrgId: actor.orgId });
    }

    return applyTempUserHeaders(
      NextResponse.json({
        upload: {
          id: String(upload._id),
          docId: upload.docId ? String(upload.docId) : null,
          status: upload.status ?? null,
          blobUrl: upload.blobUrl ?? null,
          blobPathname: upload.blobPathname ?? null,
          previewImageUrl:
            upload.previewImageUrl ?? upload.firstPagePngUrl ?? null,
          rawExtractedText:
            upload.rawExtractedText ?? upload.pdfText ?? null,
        },
      }),
      actor,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/uploads/:uploadId] PATCH failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
