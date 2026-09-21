/**
 * Admin API route: `GET|DELETE /api/admin/data/docs/:docId`
 *
 * - GET: returns the doc row and its uploads, with content and capability tokens stripped
 * - DELETE: soft-deletes a doc (sets isDeleted + deletedDate)
 *
 * The GET reads the whole row on purpose — a projection here would be a second copy of the privacy
 * rule, drifting from the one in `src/lib/admin/docPrivacy.ts` — and `redactDocRow` is what decides
 * what leaves. It has to run on the doc row in particular: the row carries `replaceUploadToken`
 * (an unrevocable code that replaces the PDF every live share link serves), the share password's
 * salt, hash and reversible copy, and `shareId`, which is simply the document.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { UploadModel } from "@/lib/models/Upload";
import { requireAdmin } from "@/lib/gating/requireAdmin";
import { redactDocRow } from "@/lib/admin/docPrivacy";

export const runtime = "nodejs";



/**
 * `GET /api/admin/data/docs/:docId`
 *
 * Returns full doc JSON + a list of related uploads (including preview/error fields),
 * so admin UIs can drill down into replacement/preview failures.
 */
export async function GET(request: Request, ctx: { params: Promise<{ docId: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { docId: docIdRaw } = await ctx.params;
  const docId = (docIdRaw ?? "").trim();
  if (!Types.ObjectId.isValid(docId)) return NextResponse.json({ error: "Invalid docId" }, { status: 400 });

  await connectMongo();

  const doc = await DocModel.findOne({ _id: new Types.ObjectId(docId) }).lean();
  if (!doc) return NextResponse.json({ error: "Doc not found" }, { status: 404 });

  const uploads = await UploadModel.find({
    docId: new Types.ObjectId(docId),
    isDeleted: { $ne: true },
  })
    .sort({ version: -1, createdDate: -1, _id: -1 })
    .select({
      userId: 1,
      orgId: 1,
      docId: 1,
      version: 1,
      status: 1,
      originalFileName: 1,
      contentType: 1,
      sizeBytes: 1,
      // Content fields are still selected so `redactDocRow` can report what exists; they are
      // stripped before the response leaves this route (see src/lib/admin/docPrivacy.ts).
      blobUrl: 1,
      blobPathname: 1,
      previewImageUrl: 1,
      firstPagePngUrl: 1,
      rawExtractedText: 1,
      pdfText: 1,
      extractedTextBlobUrl: 1,
      extractedTextBlobPathname: 1,
      aiOutput: 1,
      pageSlugs: 1,
      error: 1,
      metadata: 1,
      createdDate: 1,
      updatedDate: 1,
    })
    .lean();

  return NextResponse.json({
    ok: true,
    doc: redactDocRow({ ...(doc as Record<string, unknown>), id: String((doc as any)._id) }),
    uploads: uploads.map((u) =>
      redactDocRow({
        ...(u as Record<string, unknown>),
        id: String(u._id),
        userId: u.userId ? String(u.userId) : null,
        orgId: (u as any).orgId ? String((u as any).orgId) : null,
        docId: u.docId ? String(u.docId) : null,
        createdDate: u.createdDate ? new Date(u.createdDate).toISOString() : null,
        updatedDate: u.updatedDate ? new Date(u.updatedDate).toISOString() : null,
      }),
    ),
  });
}

/**
 *
 */
export async function DELETE(request: Request, ctx: { params: Promise<{ docId: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { docId: docIdRaw } = await ctx.params;
  const docId = (docIdRaw ?? "").trim();
  if (!Types.ObjectId.isValid(docId)) return NextResponse.json({ error: "Invalid docId" }, { status: 400 });

  await connectMongo();
  const now = new Date();
  const res = await DocModel.updateOne(
    { _id: new Types.ObjectId(docId) },
    { $set: { isDeleted: true, deletedDate: now } },
  );
  if (!res.matchedCount) return NextResponse.json({ error: "Doc not found" }, { status: 404 });

  return NextResponse.json({ ok: true, docId });
}


