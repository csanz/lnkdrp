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
import { DocModel, allocateDocUploadVersion } from "@/lib/models/Doc";
import { UploadModel } from "@/lib/models/Upload";
import { debugError, debugLog } from "@/lib/debug";
import { ensurePersonalOrgForUserId } from "@/lib/models/Org";
import { recordActivity } from "@/lib/activity/log";
import { checkRecipientUploadCap, RECIPIENT_UPLOAD_LIMIT_CODE } from "@/lib/uploads/recipientCaps";
import { clientIpFromRequest, rateLimit, rateLimitedResponse } from "@/lib/http/rateLimit";

export const runtime = "nodejs";

/**
 * Burst brake for the public side of a replace link — the same one the request-upload route has.
 *
 * This route is the other half of that pair: a capability code in a URL, no sign-in, and on the
 * strength of it we allocate a version, create an Upload and hand back a secret. It had the daily
 * cap but no per-minute brake, so the cap of twenty-odd could be spent in one round trip and the
 * two sibling routes disagreed about how hard a stranger may push. The numbers are copied from
 * src/app/api/requests/[token]/uploads/route.ts and the bucket key shape is shared
 * (`recipient-upload:ip:<ip>`), so a flood cannot simply move from one link type to the other.
 */
const START_UPLOAD_PER_IP_LIMIT = 10;
const START_UPLOAD_WINDOW_MS = 60_000;

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

    // Before any lookup or write: the daily cap below is atomic, but it is still a cap of
    // twenty-odd and nothing stopped one client from spending it in a single round trip.
    const ip = clientIpFromRequest(request);
    const burst = await rateLimit({
      key: `recipient-upload:ip:${ip}`,
      limit: START_UPLOAD_PER_IP_LIMIT,
      windowMs: START_UPLOAD_WINDOW_MS,
    });
    if (!burst.ok) {
      return rateLimitedResponse(burst, "Too many uploads from this connection. Please try again in a minute.");
    }

    await connectMongo();

    const doc = await DocModel.findOne({
      replaceUploadToken: replaceToken,
      isDeleted: { $ne: true },
    })
      .select({ _id: 1, userId: 1, orgId: 1, title: 1 })
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

    // Daily brake on recipient uploads (per link, and per Free workspace) before a version is allocated.
    const cap = await checkRecipientUploadCap({ orgId: effectiveOrgId, replaceDocId: docId });
    if (!cap.ok) {
      return NextResponse.json(
        { error: RECIPIENT_UPLOAD_LIMIT_CODE, code: RECIPIENT_UPLOAD_LIMIT_CODE, scope: cap.scope, message: cap.message },
        { status: 429, headers: { "Retry-After": "3600" } },
      );
    }

    // Monotonic per-doc version number, allocated atomically (no count-then-insert race).
    const version = await allocateDocUploadVersion(docId);

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

    void recordActivity({
      orgId: effectiveOrgId,
      userId: null,
      actorKind: "secret",
      type: "doc.replaced",
      docId,
      uploadId,
      title: (doc as { title?: unknown }).title as string | null | undefined,
      meta: { version, fileName: originalFileName },
      request,
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


