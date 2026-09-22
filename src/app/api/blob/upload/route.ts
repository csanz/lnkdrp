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
 * - `org-avatars/{orgId}/...` requires a signed-in owner or admin of that org (not an API key),
 *   and is rate-limited per member+workspace.
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
import { ORG_AVATAR_PREFIX } from "@/lib/blob/clientUpload";
import { connectMongo } from "@/lib/mongodb";
import { UploadModel } from "@/lib/models/Upload";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { resolveExistingActor } from "@/lib/gating/actor";
import { forbidApiKey } from "@/lib/gating/forbidApiKey";
import { debugError, debugLog } from "@/lib/debug";
import { actorRateLimitResponse } from "@/lib/gating/actorRateLimit";
import { rateLimit, rateLimitedResponse } from "@/lib/http/rateLimit";

export const runtime = "nodejs";

/**
 * Size ceiling for a workspace-avatar token (`org-avatars/{orgId}/...`).
 *
 * This used to be `CLIENT_UPLOAD_MAX_SIZE_BYTES` — 250MB, the *document* ceiling — for every
 * prefix, because there was only ever one number. The avatar rules (≤2MB, square, ≥120px, PNG/
 * JPG/WebP) live in `WorkspaceManager.uploadAvatarFile`, i.e. in the browser, so a caller that
 * skipped the UI and POSTed a hand-written `org-avatars/...` pathname got a token good for 250MB
 * of bytes nothing would ever reference or clean up, billed to our Blob store.
 *
 * Not 2MB exactly: the client checks 2MB against the file the *user picked*, then
 * `trimTransparentMargins` may re-encode it to PNG, and a losslessly re-encoded photo is bigger
 * than the JPEG it came from. The ceiling therefore has to leave headroom for that re-encode or it
 * would reject icons the UI accepted. 8MB keeps the headroom and still removes ~97% of the room
 * an abusive caller had.
 *
 * Not exported: route files in this app export handlers and route config only, so the number is
 * pinned by the constraints the token carries (`tests/lib/blobAvatarUploadToken.test.ts`).
 */
const AVATAR_UPLOAD_MAX_SIZE_BYTES = 8 * 1024 * 1024;

/** Avatar tokens one member may mint in one workspace per window. */
const AVATAR_TOKEN_LIMIT = 20;
/** Window for `AVATAR_TOKEN_LIMIT`, in milliseconds. */
const AVATAR_TOKEN_WINDOW_MS = 60 * 60 * 1000;

/**
 * The size ceiling for a client upload `pathname`, chosen by its prefix — the sibling of
 * `allowedContentTypesForPathname`, which already narrows the content types the same way.
 *
 * `docs/` keeps the 250MB browser-direct ceiling (those bytes go straight to Blob and are attached
 * to an `Upload` row that the pipeline and the cleanup jobs both know about); `org-avatars/` gets
 * the much smaller ceiling above.
 */
function maximumSizeInBytesForPathname(pathname: string): number {
  const p = (pathname ?? "").replace(/^\/+/, "");
  if (p.startsWith(ORG_AVATAR_PREFIX)) return AVATAR_UPLOAD_MAX_SIZE_BYTES;
  return CLIENT_UPLOAD_MAX_SIZE_BYTES;
}

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
 * A refusal raised inside the token-minting hook that already has its response built.
 *
 * `forbidApiKey` and `rateLimitedResponse` return a `NextResponse` (with the error code, the
 * `Retry-After` header and the `cache-control` the rest of the app expects). The hook can only
 * throw, so the response rides out on the error and the catch returns it unchanged rather than
 * flattening it into a bare message.
 */
class BlobUploadResponseError extends Error {
  response: NextResponse;
  constructor(response: NextResponse) {
    super("Blob upload refused");
    this.name = "BlobUploadResponseError";
    this.response = response;
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

    // Workspace branding is identity work, not document work: `/api/orgs/[orgId]/avatar` refuses
    // key actors for that reason, and the token that writes the image has to refuse them too or
    // the guard on the route that *stores* the URL is decoration.
    const keyRefusal = forbidApiKey(actor, "change a workspace avatar");
    if (keyRefusal) throw new BlobUploadResponseError(keyRefusal);

    // Any membership row used to be enough here, which meant a `viewer` — the read-only seat
    // handed to outside reviewers — could mint tokens for the workspace's avatar folder even
    // though `/api/orgs/[orgId]/avatar` would refuse to store what they uploaded. Match that
    // route: owner or admin.
    const membership = await OrgMembershipModel.findOne({
      orgId: new Types.ObjectId(avatar.orgId),
      userId: new Types.ObjectId(actor.userId),
      isDeleted: { $ne: true },
    })
      .select({ role: 1 })
      .lean();
    const role = membership ? String((membership as { role?: unknown }).role ?? "") : "";
    if (role !== "owner" && role !== "admin") {
      throw new BlobUploadAuthError(403, "Only a workspace owner or admin can change its icon");
    }

    // Nothing else limits this: `actorRateLimitResponse` below only maps the temp-user and
    // API-key ceilings, and a session caller met neither. Without a limit an admin (or anyone
    // holding their cookie) could mint tokens in a loop, and every blob written this way is
    // orphaned until `/api/orgs/:orgId/avatar` records one of them — nothing collects the rest.
    const rl = await rateLimit({
      key: `blobavatar:${actor.userId}:${avatar.orgId}`,
      limit: AVATAR_TOKEN_LIMIT,
      windowMs: AVATAR_TOKEN_WINDOW_MS,
    });
    if (!rl.ok) {
      throw new BlobUploadResponseError(
        rateLimitedResponse(rl, "Too many workspace icon uploads. Please try again later."),
      );
    }
    return;
  }

  throw new BlobUploadAuthError(403, "Invalid upload pathname");
}

/**
 * `POST /api/blob/upload`
 *
 * Implements the Vercel Blob client-upload handshake: mints short-lived client upload tokens
 * (and may accept upload-completed callbacks, though we intentionally don't rely on them).
 * Errors: 401/403 JSON on authorization failures; 429 when a caller is over the avatar-token
 * ceiling; 400 with a readable message + traceId on validation/SDK failures.
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

        // Per-prefix constraints: documents are PDF-only at the 250MB browser-direct ceiling,
        // workspace avatars are image-only at a ceiling sized for an icon. Both are per-prefix
        // because the token is the only place these are enforced — the browser's own checks are
        // a courtesy to the person using the UI, not a gate.
        const allowedContentTypes = allowedContentTypesForPathname(pathname);
        const maximumSizeInBytes = maximumSizeInBytesForPathname(pathname);
        debugLog(1, "[api/blob/upload] mint token", {
          traceId,
          pathname,
          allowedContentTypes,
          maximumSizeInBytes,
        });
        return {
          allowedContentTypes,
          maximumSizeInBytes,
          /**
           * The browser's uploads get an unguessable path too (B0,
           * `docs/prds/lnkdrp-blob-privacy.md`).
           *
           * The server pipeline was the obvious half; this is the half that matters most, because
           * the PDF and `preview.png` come through here and the preview URL is the one a recipient
           * has always been handed. `addRandomSuffix` defaults to **false** in the client-upload
           * flow, so leaving it unset left exactly the artifact the whole problem starts from
           * sitting at a path anyone could derive from two ObjectIds.
           *
           * Safe because nothing recomputes these: every call site stores what `upload()` returned
           * (`preview.url`, `blobUrl`), and `parseDocUploadBlobPathname` reads the ids from the
           * directory segments, which the suffix does not touch.
           */
          addRandomSuffix: true,
        };
      },
      // NOTE: We intentionally do NOT set `onUploadCompleted` here.
      // In local dev it causes a warning unless `VERCEL_BLOB_CALLBACK_URL` is set,
      // and our flow does not depend on callbacks (we update Mongo from the client).
    });

    return NextResponse.json(jsonResponse);
  } catch (err) {
    // Refusals that arrived with their response already built (API key, avatar rate limit).
    if (err instanceof BlobUploadResponseError) return err.response;
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
