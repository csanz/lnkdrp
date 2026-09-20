/**
 * API route for `/api/uploads`.
 *
 * Lists uploads and creates new upload records for an existing doc.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import crypto from "node:crypto";
import { connectMongo } from "@/lib/mongodb";
import { UploadModel } from "@/lib/models/Upload";
import { DocModel, allocateDocUploadVersion } from "@/lib/models/Doc";
import { debugError, debugLog } from "@/lib/debug";
import { actorRateLimitResponse } from "@/lib/gating/actorRateLimit";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { newShareId } from "@/lib/crypto/randomBase62";
import { forbidUnlessOrgRole } from "@/lib/orgs/requireOrgEditor";
import { INVALID_SUMMARY_CODE, parseAgentSummaryInput } from "@/lib/ai/agentSummary";
import { agentFromRequest, agentLabel } from "@/lib/activity/log";
import { uploadProgressFor } from "@/lib/uploads/progress";
import {
  isPdfUploadMeta,
  PDF_ONLY_ERROR_MESSAGE,
  UNSUPPORTED_FILE_TYPE_CODE,
} from "@/lib/blob/serverClientUploadRoute";
import { buildDocMatch } from "@/lib/docs/docMatch";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * List uploads (paged).
 *
 * Query params:
 * - limit, page
 * - q: searches originalFileName and doc title
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    const pageRaw = url.searchParams.get("page");
    const qRaw = url.searchParams.get("q") ?? "";
    const limit = Math.max(
      1,
      Math.min(50, Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 25),
    );
    const page = Math.max(1, Number.isFinite(Number(pageRaw)) ? Number(pageRaw) : 1);
    const q = qRaw.trim();

    debugLog(2, "[api/uploads] GET", { limit, page, q: q ? "[redacted]" : "" });
    const actor = await resolveActor(request);
    await connectMongo();

    const orgId = new Types.ObjectId(actor.orgId);
    const actorUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;

    /**
     * The **workspace** bound — the rule `src/lib/docs/docMatch.ts` states for documents, applied
     * to the uploads that carry them.
     *
     * This listing was scoped by `userId` alone and never read `actor.orgId`, which made "who
     * uploaded it" the whole of the access decision and left the workspace out of it. Two callers
     * whose access had already been taken away walked straight through:
     *
     * - an `lnk_` key is attributed to the member who minted it but scoped to *its own* workspace
     *   (`apiKeyActor.ts`), so a key issued in workspace B returned that person's rows from every
     *   workspace they had ever uploaded into — each row joined to its document's present-day
     *   title and its public `/s/:shareId` slug;
     * - a removed member's session falls back to their personal workspace, and every upload they
     *   had made in the workspace they were removed from still came back.
     *
     * `orgId` is stamped on the row at creation from the document, so the bound is on the upload
     * itself and no join can reintroduce the gap. `allowLegacyByUserId` is the same concession
     * `docMatch` makes: rows that predate workspaces carry no `orgId` and belong to a person, so
     * they resolve only while that person is sitting in their own personal workspace.
     *
     * It goes in `$and` rather than a top-level `$or`, because the search below wants an `$or` of
     * its own and assigning `filter.$or` would replace this one outright — the exact shape that
     * un-scoped document search in `/api/docs` once (see the note there).
     */
    const tenancy = allowLegacyByUserId
      ? { $or: [{ orgId }, { orgId: { $exists: false } }, { orgId: null }] }
      : { orgId };
    const and: Array<Record<string, unknown>> = [tenancy];
    const filter: Record<string, unknown> = {
      isDeleted: { $ne: true },
      userId: actorUserId,
      $and: and,
    };

    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      // Scoped to this actor's documents. Unscoped, the 100-row cap was filled from every
      // workspace in the database, so a common word could push the caller's own matching documents
      // out of the list entirely and their uploads would simply not be found. Same tenancy rule as
      // the upload filter above: a title match in a workspace the caller is not in must not even
      // reach the join, or a removed member learns titles by probing for them.
      const matchingDocs = await DocModel.find({
        title: rx,
        ...(allowLegacyByUserId
          ? {
              $or: [
                { orgId },
                { userId: actorUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
              ],
            }
          : { orgId }),
      })
        .select({ _id: 1 })
        .limit(100)
        .lean();
      const docIds = matchingDocs.map((d) => d._id);
      and.push({
        $or: [{ originalFileName: rx }, ...(docIds.length ? [{ docId: { $in: docIds } }] : [])],
      });
    }

    const total = await UploadModel.countDocuments(filter);
    const uploads = await UploadModel.find(filter)
      .sort({ createdDate: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate({ path: "docId", select: { title: 1, shareId: 1 } })
      .lean();

    return applyTempUserHeaders(
      NextResponse.json({
        total,
        page,
        limit,
        uploads: uploads.map((u) => {
          const doc = (u.docId ?? null) as
            | { _id?: unknown; title?: unknown; shareId?: unknown }
            | null;

          const docId =
            doc && doc._id ? String(doc._id) : u.docId ? String(u.docId) : null;

          return {
            id: String(u._id),
            docId,
            docTitle:
              doc && typeof doc.title === "string" && doc.title
                ? doc.title
                : typeof u.originalFileName === "string" && u.originalFileName
                  ? u.originalFileName
                  : "Untitled",
            shareId: doc && typeof doc.shareId === "string" ? doc.shareId : null,
            version: Number.isFinite(u.version) ? u.version : null,
            status: u.status ?? null,
            createdDate: u.createdDate ? new Date(u.createdDate).toISOString() : null,
          };
        }),
      }),
      actor,
    );
  } catch (err) {
    const limited = actorRateLimitResponse(err);
    if (limited) return limited;
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/uploads] GET failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/**
 * Create a new upload record for a doc.
 *
 * This also moves the doc into `preparing` state immediately so the UI can
 * render a consistent "processing" experience while the file uploads.
 */
export async function POST(request: Request) {
  const traceId = crypto.randomBytes(6).toString("base64url");
  try {
    debugLog(1, "[api/uploads] POST begin", { traceId });
    const actor = await resolveActor(request);
    // Viewers can read a workspace but must not add uploads to it.
    const forbidden = await forbidUnlessOrgRole(actor);
    if (forbidden) return forbidden;
    const body = (await request.json().catch(() => ({}))) as Partial<{
      docId: string;
      originalFileName: string;
      contentType: string;
      sizeBytes: number;
      skipReview: boolean;
      /** Agent-written summary (both or neither); skips the AI summary and costs 0 credits. */
      summary: string;
      keyPoints: string[];
    }>;

    if (!body.docId || !Types.ObjectId.isValid(body.docId)) {
      debugLog(1, "[api/uploads] POST invalid docId", { traceId });
      return NextResponse.json({ error: "Invalid docId" }, { status: 400 });
    }

    // Documents are PDF-only for now (the processing pipeline only understands PDFs).
    if (!isPdfUploadMeta({ contentType: body.contentType, fileName: body.originalFileName })) {
      debugLog(1, "[api/uploads] POST unsupported file type", {
        traceId,
        contentType: typeof body.contentType === "string" ? body.contentType : null,
      });
      return applyTempUserHeaders(
        NextResponse.json({ error: PDF_ONLY_ERROR_MESSAGE, code: UNSUPPORTED_FILE_TYPE_CODE }, { status: 415 }),
        actor,
      );
    }

    // An agent that already read the document can supply the summary itself (0 credits).
    const agentSummaryInput = parseAgentSummaryInput({ summary: body.summary, keyPoints: body.keyPoints });
    if (!agentSummaryInput.ok) {
      return applyTempUserHeaders(
        NextResponse.json({ error: agentSummaryInput.error, code: INVALID_SUMMARY_CODE }, { status: 400 }),
        actor,
      );
    }
    const requestAgent = agentFromRequest(request);
    const agentSummary = agentSummaryInput.value
      ? { ...agentSummaryInput.value, client: requestAgent?.client ?? null, label: agentLabel(requestAgent) }
      : null;

    await connectMongo();

    /**
     * The document, scoped to the **workspace** rather than to whoever uploaded it.
     *
     * This used to match on `userId: actor.userId`, which meant an invited member of a shared
     * workspace could open a document and then be told "Doc not found" when they replaced the
     * file — the one write path still using pre-workspace ownership while every read path around
     * it was org-scoped. `buildDocMatch` is the same rule `/api/docs/:docId` applies, legacy
     * personal documents included.
     */
    let doc = await DocModel.findOne(
      buildDocMatch(
        new Types.ObjectId(body.docId),
        new Types.ObjectId(actor.orgId),
        new Types.ObjectId(actor.userId),
        actor.orgId === actor.personalOrgId,
      ),
    );
    if (!doc) {
      return NextResponse.json(
        // Say which of the two it is. "Doc not found" sent a member looking for a deleted document
        // when the truth was that they were in the wrong workspace.
        { error: "Doc not found", message: "That document isn't in this workspace. Switch workspaces and try again." },
        { status: 404 },
      );
    }

    // Ensure the doc has a public shareId at upload time.
    if (!doc.shareId) {
      debugLog(2, "[api/uploads] ensure shareId", { traceId, docId: body.docId });
      for (let i = 0; i < 3; i++) {
        try {
          doc.shareId = newShareId();
          await doc.save();
          break;
        } catch (e) {
          // Duplicate shareId; retry.
          if (
            e &&
            typeof e === "object" &&
            "code" in e &&
            (e as { code?: number }).code === 11000
          )
            continue;
          throw e;
        }
      }
      // refresh instance so later responses (if any) see latest
      doc = await DocModel.findOne({
        _id: new Types.ObjectId(body.docId),
        userId: new Types.ObjectId(actor.userId),
        isDeleted: { $ne: true },
      });
    }

    // Temp-user gating only (the version number itself is allocated atomically below).
    const existingUploads = await UploadModel.countDocuments({
      docId: new Types.ObjectId(body.docId),
      userId: new Types.ObjectId(actor.userId),
      isDeleted: { $ne: true },
    });

    // Temp-user limit: 1 initial upload + 2 replacements => max 3 total versions.
    if (actor.kind === "temp" && existingUploads >= 3) {
      return applyTempUserHeaders(
        NextResponse.json(
          {
            error: "TEMP_USER_LIMIT",
            gate: { capability: "upload.replace", limit: 3, used: existingUploads },
          },
          { status: 403 },
        ),
        actor,
      );
    }

    // Guide-doc uploads are used as prompt context; keep them small and PDF-only for cost/latency safety.
    const skipReview = typeof body.skipReview === "boolean" ? body.skipReview : false;
    const sizeBytes = Number.isFinite(body.sizeBytes) ? Number(body.sizeBytes) : null;
    if (skipReview && typeof sizeBytes === "number" && sizeBytes > 1_000_000) {
      return NextResponse.json({ error: "GUIDE_DOC_TOO_LARGE (max 1MB)" }, { status: 413 });
    }
    if (skipReview) {
      const ct = typeof body.contentType === "string" ? body.contentType.trim().toLowerCase() : "";
      const name = typeof body.originalFileName === "string" ? body.originalFileName.trim().toLowerCase() : "";
      const isPdf = ct === "application/pdf" || name.endsWith(".pdf");
      if (!isPdf) {
        return NextResponse.json({ error: "GUIDE_DOC_PDF_ONLY" }, { status: 415 });
      }
    }

    // Monotonic per-doc version number (1 = initial upload, 2+ = re-uploads).
    // Allocated via an atomic `$inc` so concurrent uploads never share a version.
    const version = await allocateDocUploadVersion(new Types.ObjectId(body.docId));

    // The bar starts here, not when processing does: from the owner's side the wait begins the
    // moment they (or an agent) ask for the upload, and a row that appears only once bytes have
    // landed misses the whole import. `orgId` is stamped so the realtime server can route it.
    const initialProgress = uploadProgressFor({ stage: "created" });
    const upload = await UploadModel.create({
      userId: new Types.ObjectId(actor.userId),
      orgId: doc?.orgId ?? null,
      docId: new Types.ObjectId(body.docId),
      version,
      status: "uploading",
      progress: {
        percent: initialProgress.percent,
        stage: initialProgress.stage,
        stageKey: initialProgress.stageKey,
        orgId: doc?.orgId ?? null,
        docId: new Types.ObjectId(body.docId),
        updatedAt: new Date(),
      },
      originalFileName: body.originalFileName ?? null,
      contentType: body.contentType ?? null,
      sizeBytes,
      skipReview,
      agentSummary,
      metadata: {
        size: typeof sizeBytes === "number" ? sizeBytes : undefined,
      },
    });
    debugLog(1, "[api/uploads] created upload", { traceId, uploadId: String(upload._id), docId: body.docId, version });

    // Move doc into preparing immediately (post-share flow)
    await DocModel.findByIdAndUpdate(body.docId, {
      status: "preparing",
      currentUploadId: upload._id,
      uploadId: upload._id, // backward compat
    });

    return applyTempUserHeaders(
      NextResponse.json(
        {
          upload: {
            id: String(upload._id),
            docId: String(upload.docId),
            version: Number.isFinite(upload.version) ? upload.version : null,
            status: upload.status ?? "uploading",
            blobUrl: upload.blobUrl ?? null,
            blobPathname: upload.blobPathname ?? null,
            previewImageUrl:
              upload.previewImageUrl ?? upload.firstPagePngUrl ?? null,
            rawExtractedText:
              upload.rawExtractedText ?? upload.pdfText ?? null,
          },
        },
        { status: 201 },
      ),
      actor,
    );
  } catch (err) {
    const limited = actorRateLimitResponse(err);
    if (limited) return limited;
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/uploads] POST failed", { traceId, message });
    return NextResponse.json({ error: message, traceId }, { status: 400 });
  }
}

