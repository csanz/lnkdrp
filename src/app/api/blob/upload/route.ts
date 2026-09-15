/**
 * Vercel Blob client-upload route (App Router).
 *
 * This route is called by the browser-side `upload()` helper in `@vercel/blob/client`.
 * Responsibilities:
 * - Mint short-lived client tokens (scoped to a pathname + constraints)
 * - Optionally receive the "upload completed" callback from Vercel
 *
 * Authorization (enforced in `onBeforeGenerateToken`):
 * - `docs/{docId}/uploads/{uploadId}/...` requires either an actor (session or temp user)
 *   that owns that upload, or a valid `x-upload-secret` (header or `clientPayload`) for it.
 * - `org-avatars/{orgId}/...` requires a signed-in member of that org.
 * - Anything else is rejected.
 *
 * Identity is resolved with `resolveExistingActor` (never mints temp users): the Blob client only
 * sends cookies plus the `headers` option, so clients forward temp-user headers
 * (`tempUserHeaders()`) or the upload secret explicitly on every `upload()` call.
 *
 * Docs: https://vercel.com/docs/vercel-blob/client-upload
 */

import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import {
  CLIENT_UPLOAD_MAX_SIZE_BYTES,
  allowedContentTypesForPathname,
  assertAllowedTestPathname,
  parseDocUploadBlobPathname,
  parseOrgAvatarBlobPathname,
} from "@/lib/blob/serverClientUploadRoute";
import { connectMongo } from "@/lib/mongodb";
import { UploadModel } from "@/lib/models/Upload";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { resolveExistingActor } from "@/lib/gating/actor";
import { debugError, debugLog } from "@/lib/debug";
import { actorRateLimitResponse } from "@/lib/gating/actorRateLimit";

export const runtime = "nodejs";

/** Authorization failure raised inside the token-minting hook (mapped to a JSON status). */
class BlobUploadAuthError extends Error {
  status: 401 | 403;
  constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = "BlobUploadAuthError";
    this.status = status;
  }
}

/**
 * Extract an upload secret from the request header or the SDK `clientPayload`
 * (either a raw string or JSON `{ "uploadSecret": "..." }`).
 */
function uploadSecretFrom(request: Request, clientPayload: string | null): string | null {
  const fromHeader = (request.headers.get("x-upload-secret") ?? "").trim();
  if (fromHeader) return fromHeader;
  const raw = (clientPayload ?? "").trim();
  if (!raw) return null;
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as { uploadSecret?: unknown };
      const s = typeof parsed?.uploadSecret === "string" ? parsed.uploadSecret.trim() : "";
      return s || null;
    } catch {
      return null;
    }
  }
  return raw;
}

/**
 * Authorize a token request for `pathname`. Throws `BlobUploadAuthError` on failure.
 */
async function authorizePathname(request: Request, pathname: string, clientPayload: string | null): Promise<void> {
  const docUpload = parseDocUploadBlobPathname(pathname);
  if (docUpload) {
    await connectMongo();
    const uploadId = new Types.ObjectId(docUpload.uploadId);
    const docId = new Types.ObjectId(docUpload.docId);

    const secret = uploadSecretFrom(request, clientPayload);
    if (secret) {
      const ok = await UploadModel.exists({ _id: uploadId, docId, uploadSecret: secret, isDeleted: { $ne: true } });
      if (!ok) throw new BlobUploadAuthError(403, "Upload secret does not match this upload");
      return;
    }

    // Session/temp actor must own the upload. Never mint a temp user here: a fresh identity can
    // never own an existing upload, so an anonymous token request is simply unauthenticated.
    const actor = await resolveExistingActor(request);
    if (!actor) throw new BlobUploadAuthError(401, "Sign in (or upload secret) required");
    const ok = await UploadModel.exists({
      _id: uploadId,
      docId,
      userId: new Types.ObjectId(actor.userId),
      isDeleted: { $ne: true },
    });
    if (!ok) throw new BlobUploadAuthError(403, "Not allowed to upload to this path");
    return;
  }

  const avatar = parseOrgAvatarBlobPathname(pathname);
  if (avatar) {
    await connectMongo();
    const actor = await resolveExistingActor(request);
    if (!actor || actor.kind !== "user") throw new BlobUploadAuthError(401, "Sign in required");
    const member = await OrgMembershipModel.exists({
      orgId: new Types.ObjectId(avatar.orgId),
      userId: new Types.ObjectId(actor.userId),
      isDeleted: { $ne: true },
    });
    if (!member) throw new BlobUploadAuthError(403, "Not a member of this workspace");
    return;
  }

  throw new BlobUploadAuthError(403, "Invalid upload pathname");
}

/**
 * `POST /api/blob/upload`
 *
 * Implements the Vercel Blob client-upload handshake: mints short-lived client upload tokens
 * (and may accept upload-completed callbacks, though we intentionally don't rely on them).
 * Errors: 401/403 JSON on authorization failures; 400 with a readable message + traceId on
 * validation/SDK failures.
 */
export async function POST(request: Request) {
  const traceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    debugLog(2, "[api/blob/upload] POST begin", { traceId });
    // The SDK expects a JSON body in one of two event formats:
    // - blob.generate-client-token
    // - blob.upload-completed (callback)
    const body = (await request.json()) as HandleUploadBody;

    const jsonResponse = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        // Coarse gate: only our known prefixes.
        assertAllowedTestPathname(pathname);
        // Fine-grained gate: the caller must own (or hold the secret for) the target.
        await authorizePathname(request, pathname, clientPayload);

        // Per-prefix allowlist: documents are PDF-only, workspace avatars are image-only.
        const allowedContentTypes = allowedContentTypesForPathname(pathname);
        debugLog(1, "[api/blob/upload] mint token", { traceId, pathname, allowedContentTypes });
        return {
          allowedContentTypes,
          maximumSizeInBytes: CLIENT_UPLOAD_MAX_SIZE_BYTES,
        };
      },
      // NOTE: We intentionally do NOT set `onUploadCompleted` here.
      // In local dev it causes a warning unless `VERCEL_BLOB_CALLBACK_URL` is set,
      // and our flow does not depend on callbacks (we update Mongo from the client).
    });

    return NextResponse.json(jsonResponse);
  } catch (err) {
    const limited = actorRateLimitResponse(err);
    if (limited) return limited;
    const message = err instanceof Error ? err.message : "Unknown error";
    if (err instanceof BlobUploadAuthError) {
      debugLog(1, "[api/blob/upload] rejected", { traceId, status: err.status, message });
      return NextResponse.json({ error: message, traceId }, { status: err.status });
    }
    debugError(1, "[api/blob/upload] failed", { traceId, message });
    return NextResponse.json({ error: message, traceId }, { status: 400 });
  }
}
