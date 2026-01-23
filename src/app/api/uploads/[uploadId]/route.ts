import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { UploadModel } from "@/lib/models/Upload";
import { debugError, debugLog } from "@/lib/debug";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { DocModel } from "@/lib/models/Doc";

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
      status: "uploading" | "uploaded" | "processing" | "completed" | "failed";
      blobUrl: string;
      blobPathname: string;
      previewImageUrl: string | null;
      rawExtractedText: string | null;
      error: unknown;
      metadata: { pages?: number; size?: number; checksum?: string };
    }>;

    await connectMongo();

    const update: Record<string, unknown> = {};
    if (typeof body.status === "string") update.status = body.status;
    if (typeof body.blobUrl === "string") update.blobUrl = body.blobUrl;
    if (typeof body.blobPathname === "string")
      update.blobPathname = body.blobPathname;
    if (typeof body.previewImageUrl === "string" || body.previewImageUrl === null) {
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

    const uploadSecret = header(request, "x-upload-secret");
    if (typeof uploadSecret === "string" && uploadSecret.trim()) {
      const trimmed = uploadSecret.trim();
      debugLog(2, "[api/uploads/:uploadId] PATCH secret-auth", {
        uploadId,
        hasSecret: true,
        secretLen: trimmed.length,
      });
      if ("previewImageUrl" in update) {
        debugLog(1, "[api/uploads/:uploadId] PATCH previewImageUrl (secret)", {
          uploadId,
          hasPreview: Boolean(update.previewImageUrl),
        });
      }

      // Debug-friendly behavior: distinguish between missing upload vs secret mismatch.
      // (This route is used by capability flows; returning a clearer error helps diagnose issues.)
      const exists = await UploadModel.findOne({
        _id: new Types.ObjectId(uploadId),
        isDeleted: { $ne: true },
      })
        .select({ _id: 1, uploadSecret: 1 })
        .lean();
      if (!exists) return NextResponse.json({ error: "Not found" }, { status: 404 });

      const stored = typeof (exists as any).uploadSecret === "string" ? String((exists as any).uploadSecret).trim() : "";
      if (!stored) {
        return NextResponse.json({ error: "UPLOAD_SECRET_NOT_ENABLED" }, { status: 403 });
      }
      if (stored !== trimmed) {
        return NextResponse.json({ error: "UPLOAD_SECRET_MISMATCH" }, { status: 403 });
      }

      const upload = await UploadModel.findOneAndUpdate(
        { _id: new Types.ObjectId(uploadId), uploadSecret: trimmed, isDeleted: { $ne: true } },
        update,
        { new: true },
      ).lean();
      if (!upload) return NextResponse.json({ error: "Not found" }, { status: 404 });

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
    if ("previewImageUrl" in update) {
      debugLog(1, "[api/uploads/:uploadId] PATCH previewImageUrl (actor)", {
        uploadId,
        hasPreview: Boolean(update.previewImageUrl),
      });
    }
    const upload = await UploadModel.findOneAndUpdate(
      { _id: new Types.ObjectId(uploadId), userId: new Types.ObjectId(actor.userId) },
      update,
      { new: true },
    ).lean();
    if (!upload) return NextResponse.json({ error: "Not found" }, { status: 404 });

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





