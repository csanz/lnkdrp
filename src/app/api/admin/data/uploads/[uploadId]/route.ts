/**
 * Admin API route: `GET|DELETE /api/admin/data/uploads/:uploadId`
 *
 * - GET: returns the upload row for inspection (including `error.details`), minus content and tokens
 * - DELETE: soft-deletes an upload (sets isDeleted + deletedDate)
 *
 * `redactDocRow` is load-bearing here for a second reason beyond content: an upload row carries
 * `uploadSecret`, which `PATCH /api/uploads/:id` accepts as `x-upload-secret` with no session at
 * all. Handing it to staff was handing out a permanent write capability over a customer's live
 * document — and the activity row it writes is attributed to the owner's own workspace.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { UploadModel } from "@/lib/models/Upload";
import { requireAdmin } from "@/lib/gating/requireAdmin";
import { redactDocRow } from "@/lib/admin/docPrivacy";

export const runtime = "nodejs";



/**
 * `GET /api/admin/data/uploads/:uploadId`
 *
 * Returns the full upload record so admin UIs can inspect preview-generation errors
 * (e.g. `error.details.preview`) and artifact pointers (`previewImageUrl`, `blobUrl`, etc).
 */
export async function GET(request: Request, ctx: { params: Promise<{ uploadId: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { uploadId: uploadIdRaw } = await ctx.params;
  const uploadId = (uploadIdRaw ?? "").trim();
  if (!Types.ObjectId.isValid(uploadId)) return NextResponse.json({ error: "Invalid uploadId" }, { status: 400 });

  await connectMongo();
  const upload = await UploadModel.findOne({ _id: new Types.ObjectId(uploadId) }).lean();
  if (!upload) return NextResponse.json({ error: "Upload not found" }, { status: 404 });

  return NextResponse.json({
    ok: true,
    // The whole upload row minus its content (file URL, preview, extracted text, AI output) and
    // minus its capability tokens (`uploadSecret`).
    upload: redactDocRow({
      ...(upload as Record<string, unknown>),
      id: String((upload as any)._id),
      userId: (upload as any).userId ? String((upload as any).userId) : null,
      orgId: (upload as any).orgId ? String((upload as any).orgId) : null,
      docId: (upload as any).docId ? String((upload as any).docId) : null,
      createdDate: (upload as any).createdDate ? new Date((upload as any).createdDate).toISOString() : null,
      updatedDate: (upload as any).updatedDate ? new Date((upload as any).updatedDate).toISOString() : null,
    }),
  });
}

/**
 *
 */
export async function DELETE(request: Request, ctx: { params: Promise<{ uploadId: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { uploadId: uploadIdRaw } = await ctx.params;
  const uploadId = (uploadIdRaw ?? "").trim();
  if (!Types.ObjectId.isValid(uploadId)) return NextResponse.json({ error: "Invalid uploadId" }, { status: 400 });

  await connectMongo();
  const now = new Date();
  const res = await UploadModel.updateOne(
    { _id: new Types.ObjectId(uploadId) },
    { $set: { isDeleted: true, deletedDate: now } },
  );
  if (!res.matchedCount) return NextResponse.json({ error: "Upload not found" }, { status: 404 });

  return NextResponse.json({ ok: true, uploadId });
}


