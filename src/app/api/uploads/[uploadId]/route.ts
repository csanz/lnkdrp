import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { UploadModel } from "@/lib/models/Upload";
import { debugError, debugLog } from "@/lib/debug";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { DocModel } from "@/lib/models/Doc";
import {
  isBlobPathnameForUpload,
  isBlobUrlForUpload,
  isPdfUploadMeta,
  PDF_ONLY_ERROR_MESSAGE,
  UNSUPPORTED_FILE_TYPE_CODE,
} from "@/lib/blob/serverClientUploadRoute";
import { recordActivity } from "@/lib/activity/log";

export const runtime = "nodejs";
/**
 * Header (uses get, toLowerCase).
 */


function header(request: Request, name: string) {
  return request.headers.get(name) ?? request.headers.get(name.toLowerCase());
}

/**
 * "Which upload may this actor reach?" — the workspace bound, written once for this file.
 *
 * Uploads are owned by a **workspace**: `POST /api/uploads` resolves the document with
 * `buildDocMatch` and then stamps `orgId: doc.orgId` on the row while `userId` records only who
 * pushed the bytes. "I uploaded this" and "I may still reach that workspace" are therefore two
 * different facts, and a filter of `{ _id, userId }` answers the first while pretending to answer
 * the second. Two callers whose access had already been taken away walk through it: an `lnk_` key
 * is attributed to the member who minted it but scoped to *its own* workspace, and a removed
 * member's session falls back to their personal one.
 *
 * The bound arrived on the GET in this file and on `import-url` / `import-bytes` next door, but
 * PATCH kept the pre-workspace rule in both of its filters — the pre-read and the write itself —
 * which made it the one handler in the directory still deciding access by uploader alone. That is
 * also the handler with the most to lose: `buildPatchUpdate(..., "owner")` is the only caller
 * allowed to set `rawExtractedText`, and the processor skips `pdfParse` entirely when a value is
 * already on the row, so what lands here is read downstream *as the contents of the PDF*.
 *
 * A reader comparing the two handlers thirty lines apart would have concluded the comment on GET
 * covered both. Building the filter in one function is what makes that true: there is no second
 * copy left to fall behind. `allowLegacyByUserId` is `docMatch.ts`'s concession for rows that
 * predate workspaces — those belong to a person, so they resolve only while that person is in
 * their own personal workspace. The tenancy clause goes inside `$and` so that a caller adding an
 * `$or` of their own later cannot silently replace it.
 */
function buildUploadMatch(
  uploadId: string,
  actor: { userId: string; orgId: string; personalOrgId: string },
): Record<string, unknown> {
  const orgId = new Types.ObjectId(actor.orgId);
  const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
  const tenancy = allowLegacyByUserId
    ? { $or: [{ orgId }, { orgId: { $exists: false } }, { orgId: null }] }
    : { orgId };
  return {
    _id: new Types.ObjectId(uploadId),
    userId: new Types.ObjectId(actor.userId),
    isDeleted: { $ne: true },
    $and: [tenancy],
  };
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
          // "A new version landed and it reads exactly like the last one" — the replacing UI says
          // so rather than reporting an ordinary success for a file that changed nothing.
          unchangedFromPrevious: Boolean((upload as { unchangedFromPrevious?: unknown }).unchangedFromPrevious),
          ai: (upload as { ai?: unknown }).ai ?? null,
          // Why a failed upload failed. Without it a caller (the MCP's share_pdf, the upload UI)
          // could only say "failed" and leave the person guessing whether to retry.
          error: (function () {
            const e = (upload as { error?: unknown }).error;
            const msg = e && typeof e === "object" ? (e as { message?: unknown }).message : null;
            return typeof msg === "string" && msg.trim() ? msg.trim().slice(0, 300) : null;
          })(),
        },
        doc: {
          id: upload.docId ? String(upload.docId) : null,
          status: doc?.status ?? null,
        },
      });
    }

    const actor = await resolveActor(request);
    /**
     * The same workspace bound the listing beside this one carries — see `buildUploadMatch`.
     *
     * It was owner-scoped alone (`userId`), which is the gap that was closed on `GET /api/uploads`
     * and left standing here: the detail endpoint one directory over, reachable by anyone holding
     * an upload id.
     */
    const upload = await UploadModel.findOne(buildUploadMatch(uploadId, actor)).lean();
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
          // "A new version landed and it reads exactly like the last one" — the replacing UI says
          // so rather than reporting an ordinary success for a file that changed nothing.
          unchangedFromPrevious: Boolean((upload as { unchangedFromPrevious?: unknown }).unchangedFromPrevious),
          ai: (upload as { ai?: unknown }).ai ?? null,
          // Why a failed upload failed. Without it a caller (the MCP's share_pdf, the upload UI)
          // could only say "failed" and leave the person guessing whether to retry.
          error: (function () {
            const e = (upload as { error?: unknown }).error;
            const msg = e && typeof e === "object" ? (e as { message?: unknown }).message : null;
            return typeof msg === "string" && msg.trim() ? msg.trim().slice(0, 300) : null;
          })(),
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
 * Statuses a client is allowed to set. Pipeline-owned states (`processing`, `completed`)
 * are only ever written by the process route.
 */
const CLIENT_SETTABLE_STATUSES = new Set(["uploaded", "failed"]);

/**
 * Who is PATCHing: the owner of the upload (an authenticated actor) or someone holding nothing but
 * the upload secret a request/replace link handed to an anonymous recipient.
 */
type PatchCaller = "owner" | "uploadSecret";

/**
 * Ceiling on stored extracted text, in characters.
 *
 * The field was unbounded, so one PATCH could push an arbitrarily large string into the row and
 * from there into every model call that reads it. 1MB is the same order as the byte cap the
 * processor already applies to text it sends onward.
 */
const MAX_RAW_EXTRACTED_TEXT_CHARS = 1_000_000;

/**
 * Build the sanitized `$set` update from a client PATCH body.
 *
 * Blob URLs/pathnames are only accepted when they point at our Blob store *and* live under
 * this upload's own folder (`docs/{docId}/uploads/{uploadId}/`), so a client cannot attach
 * an arbitrary remote file (or another upload's file) to this record.
 *
 * Returns `{ error }` on validation failures.
 */
function buildPatchUpdate(
  body: Partial<{
    status: string;
    blobUrl: string;
    blobPathname: string;
    previewImageUrl: string | null;
    rawExtractedText: string | null;
    error: unknown;
    metadata: { pages?: number; size?: number; checksum?: string };
  }>,
  scope: { docId: string; uploadId: string },
  caller: PatchCaller,
): { update: Record<string, unknown> } | { error: string } {
  const update: Record<string, unknown> = {};
  if (typeof body.status === "string") {
    if (!CLIENT_SETTABLE_STATUSES.has(body.status)) {
      return { error: `Invalid status (allowed: ${[...CLIENT_SETTABLE_STATUSES].join(", ")})` };
    }
    update.status = body.status;
  }
  if (typeof body.blobUrl === "string") {
    if (!scope.docId || !isBlobUrlForUpload(body.blobUrl, scope)) {
      return { error: "Invalid blobUrl (must point at this upload's blob folder)" };
    }
    update.blobUrl = body.blobUrl;
  }
  if (typeof body.blobPathname === "string") {
    if (!scope.docId || !isBlobPathnameForUpload(body.blobPathname, scope)) {
      return { error: "Invalid blobPathname (must be under this upload's blob folder)" };
    }
    update.blobPathname = body.blobPathname;
  }
  if (typeof body.previewImageUrl === "string" || body.previewImageUrl === null) {
    if (typeof body.previewImageUrl === "string" && (!scope.docId || !isBlobUrlForUpload(body.previewImageUrl, scope))) {
      return { error: "Invalid previewImageUrl (must point at this upload's blob folder)" };
    }
    update.previewImageUrl = body.previewImageUrl;
    // keep compat field in sync
    update.firstPagePngUrl = body.previewImageUrl;
  }
  /**
   * `rawExtractedText` is the document's text, and the processor treats a value already on the row
   * as authoritative: it skips `pdfParse` entirely when one is present, copies it onto the Doc, and
   * feeds it to the summariser and the review agent on the owner's spend. So accepting it here from
   * a caller holding only an upload secret — which `POST /api/requests/:token/uploads` hands to
   * anyone who can invent an `x-lnkdrp-botid` — let a stranger write what the owner would read as
   * the contents of their own PDF, with the real file never opened. Only the owner branch may set
   * it; the secret branch never needs to, because extraction happens server-side from the bytes.
   *
   * Dropped rather than refused with a 400: recipients send this field in the same body that
   * carries `status: "uploaded"`, so rejecting would strand a mid-flight upload over a field the
   * flow does not depend on. A stale cached client keeps working and simply has its text ignored.
   */
  if (typeof body.rawExtractedText === "string" || body.rawExtractedText === null) {
    if (caller === "owner") {
      const text =
        typeof body.rawExtractedText === "string"
          ? body.rawExtractedText.slice(0, MAX_RAW_EXTRACTED_TEXT_CHARS)
          : null;
      update.rawExtractedText = text;
      // keep compat field in sync
      update.pdfText = text;
    } else {
      debugLog(1, "[api/uploads/:uploadId] PATCH ignored rawExtractedText (secret)", {
        uploadId: scope.uploadId,
      });
    }
  }
  if (body.error !== undefined) update.error = body.error;
  if (body.metadata && typeof body.metadata === "object") update.metadata = body.metadata;
  return { update };
}

/**
 * Return whether an upload being marked `uploaded` is a PDF.
 *
 * Uses the metadata stored at creation time (`contentType` / `originalFileName`); when neither was
 * recorded, falls back to the extension of the blob pathname being attached. Documents are PDF-only.
 */
function isPdfUploadRecord(
  stored: { contentType?: unknown; originalFileName?: unknown },
  update: Record<string, unknown>,
): boolean {
  const contentType = typeof stored.contentType === "string" ? stored.contentType : "";
  const originalFileName = typeof stored.originalFileName === "string" ? stored.originalFileName : "";
  const blobPathname = typeof update.blobPathname === "string" ? update.blobPathname : "";
  const blobName = blobPathname.split("/").pop() ?? "";
  if (blobName && !/\.pdf$/i.test(blobName)) return false;
  const hasStoredMeta = Boolean(contentType.trim() || originalFileName.trim());
  return hasStoredMeta ? isPdfUploadMeta({ contentType, fileName: originalFileName }) : /\.pdf$/i.test(blobName);
}

/**
 * Record `upload.completed` once an upload transitions to `uploaded` (best-effort; never throws).
 */
async function logUploadCompleted(params: {
  request: Request;
  upload: {
    _id: unknown;
    docId?: unknown;
    userId?: unknown;
    orgId?: unknown;
    version?: unknown;
    originalFileName?: unknown;
    sizeBytes?: unknown;
    metadata?: unknown;
  };
  actorKind: "user" | "temp" | "secret";
  fallbackOrgId?: string | null;
}): Promise<void> {
  const { request, upload, actorKind, fallbackOrgId } = params;
  const docId = upload.docId ? String(upload.docId) : null;
  const doc = docId
    ? await DocModel.findById(docId).select({ orgId: 1, title: 1 }).lean().catch(() => null)
    : null;
  const docOrgId = doc && (doc as { orgId?: unknown }).orgId ? String((doc as { orgId?: unknown }).orgId) : null;
  const orgId = docOrgId ?? (upload.orgId ? String(upload.orgId) : null) ?? fallbackOrgId ?? null;
  if (!orgId) return;
  const meta = upload.metadata && typeof upload.metadata === "object" ? (upload.metadata as { size?: unknown }) : null;
  const sizeBytes =
    typeof upload.sizeBytes === "number" ? upload.sizeBytes : typeof meta?.size === "number" ? meta.size : null;
  void recordActivity({
    orgId,
    userId: upload.userId ? String(upload.userId) : null,
    actorKind,
    type: "upload.completed",
    docId,
    uploadId: String(upload._id),
    title: doc && typeof (doc as { title?: unknown }).title === "string" ? (doc as { title: string }).title : null,
    meta: {
      fileName: typeof upload.originalFileName === "string" ? upload.originalFileName : null,
      sizeBytes,
      version: typeof upload.version === "number" ? upload.version : null,
    },
    request,
  });
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
      status: string;
      blobUrl: string;
      blobPathname: string;
      previewImageUrl: string | null;
      rawExtractedText: string | null;
      error: unknown;
      metadata: { pages?: number; size?: number; checksum?: string };
    }>;

    await connectMongo();

    const uploadSecret = header(request, "x-upload-secret");
    if (typeof uploadSecret === "string" && uploadSecret.trim()) {
      const trimmed = uploadSecret.trim();
      debugLog(2, "[api/uploads/:uploadId] PATCH secret-auth", {
        uploadId,
        hasSecret: true,
        secretLen: trimmed.length,
      });

      /**
       * One answer for every refusal, because this caller is anonymous.
       *
       * This used to answer 404 for "no such upload", `UPLOAD_SECRET_NOT_ENABLED` for one with no
       * secret, and `UPLOAD_SECRET_MISMATCH` for a wrong one — a comment described that as
       * debug-friendly. It is the response-shape oracle `docs/SECURITY.md` section 7 already lists
       * as a bug class: a holder of any upload id learns whether it exists and whether it is open
       * to secret-auth, without holding the secret. Nothing consumed the two codes.
       *
       * The detail still exists, in the server log, where the person diagnosing can see it and the
       * person probing cannot.
       */
      const exists = await UploadModel.findOne({
        _id: new Types.ObjectId(uploadId),
        isDeleted: { $ne: true },
      })
        .select({ _id: 1, uploadSecret: 1, docId: 1, contentType: 1, originalFileName: 1 })
        .lean();
      const stored =
        exists && typeof (exists as any).uploadSecret === "string" ? String((exists as any).uploadSecret).trim() : "";
      /**
       * Constant-time, because this is a bearer secret compared in the application.
       *
       * The GET path above matches it inside the Mongo filter, which never shortcuts on the first
       * differing byte; this one did `stored !== trimmed`. Length is checked first because
       * `timingSafeEqual` throws on a mismatch — the same shape as `internalProcess.ts` and
       * `acceptToken.ts`.
       */
      const secretOk = (() => {
        if (!stored) return false;
        const a = Buffer.from(stored);
        const b = Buffer.from(trimmed);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
      })();

      if (!exists || !secretOk) {
        debugLog(1, "[api/uploads/:uploadId] PATCH secret refused", {
          uploadId,
          reason: !exists ? "no_such_upload" : !stored ? "secret_not_enabled" : "secret_mismatch",
        });
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }

      const built = buildPatchUpdate(body, { docId: exists.docId ? String(exists.docId) : "", uploadId }, "uploadSecret");
      if ("error" in built) return NextResponse.json({ error: built.error }, { status: 400 });
      const update = built.update;
      if (update.status === "uploaded" && !isPdfUploadRecord(exists, update)) {
        debugLog(1, "[api/uploads/:uploadId] PATCH unsupported file type (secret)", { uploadId });
        return NextResponse.json({ error: PDF_ONLY_ERROR_MESSAGE, code: UNSUPPORTED_FILE_TYPE_CODE }, { status: 415 });
      }
      if ("previewImageUrl" in update) {
        debugLog(1, "[api/uploads/:uploadId] PATCH previewImageUrl (secret)", {
          uploadId,
          hasPreview: Boolean(update.previewImageUrl),
        });
      }

      const upload = await UploadModel.findOneAndUpdate(
        { _id: new Types.ObjectId(uploadId), uploadSecret: trimmed, isDeleted: { $ne: true } },
        update,
        { new: true },
      ).lean();
      if (!upload) return NextResponse.json({ error: "Not found" }, { status: 404 });

      if (update.status === "uploaded") {
        // Link recipients act inside the owner's workspace; attribute the row to the owner as "secret".
        void logUploadCompleted({ request, upload, actorKind: "secret" });
      }

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
    /**
     * The workspace bound, not just the uploader — the write side of what the GET above already
     * does. This branch may set `rawExtractedText`, which the processor treats as the document's
     * contents in place of the real file, so matching on `userId` alone let a removed member or an
     * `lnk_` key from another workspace rewrite what this workspace then reads and pays a model to
     * summarise. Both filters below use the same match: the write is not authorised by the fact
     * that the pre-read succeeded.
     */
    const uploadMatch = buildUploadMatch(uploadId, actor);
    const owned = await UploadModel.findOne(uploadMatch)
      .select({ _id: 1, docId: 1, contentType: 1, originalFileName: 1 })
      .lean();
    if (!owned) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    const built = buildPatchUpdate(body, { docId: owned.docId ? String(owned.docId) : "", uploadId }, "owner");
    if ("error" in built) {
      return applyTempUserHeaders(NextResponse.json({ error: built.error }, { status: 400 }), actor);
    }
    const update = built.update;
    if (update.status === "uploaded" && !isPdfUploadRecord(owned, update)) {
      debugLog(1, "[api/uploads/:uploadId] PATCH unsupported file type (actor)", { uploadId });
      return applyTempUserHeaders(
        NextResponse.json({ error: PDF_ONLY_ERROR_MESSAGE, code: UNSUPPORTED_FILE_TYPE_CODE }, { status: 415 }),
        actor,
      );
    }
    if ("previewImageUrl" in update) {
      debugLog(1, "[api/uploads/:uploadId] PATCH previewImageUrl (actor)", {
        uploadId,
        hasPreview: Boolean(update.previewImageUrl),
      });
    }
    const upload = await UploadModel.findOneAndUpdate(uploadMatch, update, { new: true }).lean();
    if (!upload) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (update.status === "uploaded") {
      void logUploadCompleted({ request, upload, actorKind: actor.kind, fallbackOrgId: actor.orgId });
    }

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
