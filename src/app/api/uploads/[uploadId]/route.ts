import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { UploadModel } from "@/lib/models/Upload";
import { debugError, debugLog } from "@/lib/debug";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";

export const runtime = "nodejs";

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
    const actor = await resolveActor(request);
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




