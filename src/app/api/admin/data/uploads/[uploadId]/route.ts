/**
 * Admin API route: `GET|DELETE /api/admin/data/uploads/:uploadId`
 *
 * - GET: returns full upload details (lean) for inspection (including `error.details`)
 * - DELETE: soft-deletes an upload (sets isDeleted + deletedDate)
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { resolveActor } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";
import { UploadModel } from "@/lib/models/Upload";
import { UserModel } from "@/lib/models/User";

export const runtime = "nodejs";

function isLocalhostRequest(request: Request) {
  if (process.env.NODE_ENV === "production") return false;
  const host = (request.headers.get("host") ?? "").toLowerCase();
  return host.startsWith("localhost:") || host.startsWith("127.0.0.1:");
}

async function requireAdmin(request: Request) {
  if (isLocalhostRequest(request)) {
    return { ok: true as const, userId: null as string | null };
  }
  const actor = await resolveActor(request);
  if (actor.kind !== "user" || !Types.ObjectId.isValid(actor.userId)) {
    return { ok: false as const, status: 401, error: "Not authenticated" };
  }

  await connectMongo();
  const u = await UserModel.findOne({ _id: new Types.ObjectId(actor.userId) })
    .select({ role: 1 })
    .lean();
  const role = (u as { role?: unknown } | null)?.role;
  if (role !== "admin") return { ok: false as const, status: 403, error: "Forbidden" };

  return { ok: true as const, userId: actor.userId };
}

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
    upload: {
      ...upload,
      id: String((upload as any)._id),
      userId: (upload as any).userId ? String((upload as any).userId) : null,
      orgId: (upload as any).orgId ? String((upload as any).orgId) : null,
      docId: (upload as any).docId ? String((upload as any).docId) : null,
      createdDate: (upload as any).createdDate ? new Date((upload as any).createdDate).toISOString() : null,
      updatedDate: (upload as any).updatedDate ? new Date((upload as any).updatedDate).toISOString() : null,
    },
  });
}

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
    { $set: { isDeleted: true, deletedDate: now, isDeletedDate: now } },
  );
  if (!res.matchedCount) return NextResponse.json({ error: "Upload not found" }, { status: 404 });

  return NextResponse.json({ ok: true, uploadId });
}


