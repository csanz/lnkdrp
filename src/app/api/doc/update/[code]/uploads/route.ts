/**
 * API route for `/api/doc/update/:code/uploads`.
 *
 * Starts a replacement upload for a specific doc using a capability code
 * (`Doc.replaceUploadToken`) and returns an `uploadSecret` for follow-up calls.
 */
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { UploadModel } from "@/lib/models/Upload";
import { debugError, debugLog } from "@/lib/debug";
import { ensurePersonalOrgForUserId } from "@/lib/models/Org";

export const runtime = "nodejs";

/**
 * New Upload Secret (uses toString, randomBytes).
 */
function newUploadSecret() {
  // Capability secret for this upload (used by recipient to PATCH/process without auth).
  return crypto.randomBytes(24).toString("base64url");
}

export async function POST(request: Request, ctx: { params: Promise<{ code: string }> }) {
  try {
    const { code } = await ctx.params;
    const replaceToken = decodeURIComponent(code || "").trim();
    if (!replaceToken) return NextResponse.json({ error: "Invalid code" }, { status: 400 });

    const body = (await request.json().catch(() => ({}))) as Partial<{
      originalFileName: string;
      contentType: string;
      sizeBytes: number;
    }>;
    const originalFileName =
      typeof body.originalFileName === "string" ? body.originalFileName.trim() : "";
    const contentType = typeof body.contentType === "string" ? body.contentType.trim() : "";
    const sizeBytes = Number.isFinite(body.sizeBytes) ? Number(body.sizeBytes) : null;

    if (!originalFileName) {
      return NextResponse.json({ error: "Missing originalFileName" }, { status: 400 });
    }

    debugLog(1, "[api/doc/update/:code/uploads] POST", { code: "[redacted]" });
    await connectMongo();

    const doc = await DocModel.findOne({
      replaceUploadToken: replaceToken,
      isDeleted: { $ne: true },
    })
      .select({ _id: 1, userId: 1, orgId: 1 })
      .lean();

    if (!doc || !doc._id || !(doc as { userId?: unknown }).userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const docId = new Types.ObjectId(String(doc._id));
    const ownerUserId = new Types.ObjectId(String((doc as { userId: unknown }).userId));
    const docOrgIdRaw = (doc as unknown as { orgId?: unknown }).orgId;
    const effectiveOrgId =
      docOrgIdRaw && Types.ObjectId.isValid(String(docOrgIdRaw))
        ? new Types.ObjectId(String(docOrgIdRaw))
        : (await ensurePersonalOrgForUserId({ userId: ownerUserId })).orgId;

    const existingUploads = await UploadModel.countDocuments({
      docId,
      userId: ownerUserId,
      isDeleted: { $ne: true },
    });
    const version = existingUploads + 1;

    const uploadSecret = newUploadSecret();
    const upload = await UploadModel.create({
      orgId: effectiveOrgId,
      userId: ownerUserId,
      docId,
      version,
      status: "uploading",
      originalFileName,
      contentType: contentType || null,
      sizeBytes,
      metadata: {
        size: sizeBytes ?? undefined,
      },
      uploadSecret,
    });

    const uploadId = (upload as unknown as { _id?: Types.ObjectId })._id ?? null;
    if (!uploadId) throw new Error("Failed to create upload");

    await DocModel.findByIdAndUpdate(docId, {
      status: "preparing",
      currentUploadId: uploadId,
      uploadId, // backward compat
    });

    return NextResponse.json(
      {
        doc: { id: String(docId) },
        upload: { id: String(uploadId), secret: uploadSecret },
      },
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/doc/update/:code/uploads] POST failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


