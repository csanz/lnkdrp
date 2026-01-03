/**
 * API route for `/api/doc/update/:code`.
 *
 * Resolves a replacement upload code (`Doc.replaceUploadToken`) to a doc metadata payload
 * so the public update page can show what will be replaced (title, preview, share link, version).
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { UploadModel } from "@/lib/models/Upload";
import { debugError, debugLog } from "@/lib/debug";

export const runtime = "nodejs";

export async function GET(request: Request, ctx: { params: Promise<{ code: string }> }) {
  try {
    const { code } = await ctx.params;
    const token = decodeURIComponent(code || "").trim();
    if (!token) return NextResponse.json({ error: "Invalid code" }, { status: 400 });

    debugLog(2, "[api/doc/update/:code] GET", { code: "[redacted]" });
    await connectMongo();

    const doc = await DocModel.findOne({
      replaceUploadToken: token,
      isDeleted: { $ne: true },
    })
      .select({ _id: 1, title: 1, shareId: 1, previewImageUrl: 1, firstPagePngUrl: 1, currentUploadId: 1, uploadId: 1 })
      .lean();

    if (!doc || !doc._id) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const currentUploadIdRaw =
      (doc as unknown as { currentUploadId?: unknown }).currentUploadId ??
      (doc as unknown as { uploadId?: unknown }).uploadId ??
      null;
    const currentUploadId =
      currentUploadIdRaw && Types.ObjectId.isValid(String(currentUploadIdRaw))
        ? new Types.ObjectId(String(currentUploadIdRaw))
        : null;

    const upload = currentUploadId ? await UploadModel.findById(currentUploadId).select({ version: 1 }).lean() : null;

    return NextResponse.json({
      doc: {
        id: String(doc._id),
        title: typeof (doc as any).title === "string" ? (doc as any).title : "Document",
        shareId: typeof (doc as any).shareId === "string" ? (doc as any).shareId : null,
        previewImageUrl: (doc as any).previewImageUrl ?? (doc as any).firstPagePngUrl ?? null,
        currentVersion: upload && Number.isFinite((upload as any).version) ? Number((upload as any).version) : null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/doc/update/:code] GET failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


