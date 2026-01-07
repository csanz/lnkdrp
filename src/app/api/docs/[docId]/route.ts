/**
 * API route for `/api/docs/:docId`.
 *
 * Fetches and updates a doc (ensures it has a public `/s/:shareId`).
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import crypto from "node:crypto";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { ProjectModel } from "@/lib/models/Project";
import { UploadModel } from "@/lib/models/Upload";
import { UserModel } from "@/lib/models/User";
import { debugEnabled, debugError, debugLog } from "@/lib/debug";
import { applyTempUserHeaders, resolveActor, tryResolveUserActorFast } from "@/lib/gating/actor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/**
 * Random Base62 (uses randomBytes, max, ceil).
 */


function randomBase62(length: number): string {
  let out = "";
  while (out.length < length) {
    const remaining = length - out.length;
    const buf = crypto.randomBytes(Math.max(8, Math.ceil(remaining * 1.25)));
    for (const b of buf) {
      // 62 * 4 = 248, so values 0..247 map evenly to base62.
      if (b < 248) out += BASE62_ALPHABET[b % 62];
      if (out.length >= length) break;
    }
  }
  return out;
}
/**
 * Return whether object id.
 */


function isObjectId(id: string) {
  return Types.ObjectId.isValid(id);
}
/**
 * New Share Id (uses randomBase62).
 */


function newShareId() {
  // Alphanumeric only (no dashes/special chars) for friendlier share URLs.
  return randomBase62(12);
}

/**
 * Generate a secret token for a public "replace upload" link for a doc.
 *
 * This is a capability token (treat as secret) and should be long enough to be unguessable.
 */
function newReplaceUploadToken() {
  return randomBase62(24);
}
/**
 * Handle GET requests.
 */


export async function GET(
  request: Request,
  ctx: { params: Promise<{ docId: string }> },
) {
  try {
    const url = new URL(request.url);
    const wantsDebug = url.searchParams.get("debug") === "1";
    const wantsDebugUploads = url.searchParams.get("debugUploads") === "1";
    const lite = url.searchParams.get("lite") === "1";
    // In local dev, allow `?debug=1` without requiring DEBUG env.
    const includeDebug = wantsDebug && (process.env.NODE_ENV !== "production" || debugEnabled(1));

    const { docId } = await ctx.params;
    if (!isObjectId(docId)) {
      return NextResponse.json({ error: "Invalid docId" }, { status: 400 });
    }

    debugLog(2, "[api/docs/:docId] GET", { docId, includeDebug, lite });
    const actor = (lite ? await tryResolveUserActorFast(request) : null) ?? (await resolveActor(request));
    await connectMongo();
    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
    const docObjectId = new Types.ObjectId(docId);
    const docMatch = allowLegacyByUserId
      ? {
          $or: [
            { _id: docObjectId, orgId },
            { _id: docObjectId, userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
          ],
        }
      : { _id: docObjectId, orgId };

    // Fetch doc (lean) so we don't pay for a full Mongoose document instance on this hot path.
    // NOTE: We still do a few best-effort backfills below; keep them lightweight.
    let docLean = await DocModel.findOne({ ...docMatch }).lean();
    if (!docLean) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Best-effort: backfill orgId for legacy personal docs.
    if (allowLegacyByUserId && !(docLean as unknown as { orgId?: unknown }).orgId) {
      try {
        await DocModel.updateOne(
          { _id: docObjectId, userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
          { $set: { orgId } },
        );
        (docLean as unknown as { orgId?: Types.ObjectId }).orgId = orgId;
      } catch {
        // ignore; best-effort
      }
    }

    if (!(docLean as any).shareId) {
      let ensured = false;
      for (let i = 0; i < 5; i++) {
        const candidate = newShareId();
        try {
          const updated = await DocModel.findOneAndUpdate(
            {
              ...docMatch,
              shareId: { $in: [null, undefined, ""] },
            },
            { $set: { shareId: candidate } },
            { new: true },
          ).lean();
          if (updated) {
            docLean = updated;
            ensured = true;
            break;
          }
          // Another request beat us to it; re-fetch and continue.
          docLean = await DocModel.findOne({ ...docMatch }).lean();
          if ((docLean as any)?.shareId) {
            ensured = true;
            break;
          }
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
      if (!ensured || !doc?.shareId) {
        throw new Error("Failed to ensure shareId for doc");
      }
    }

    // Ensure request-received docs have a replacement upload token (best-effort).
    // Keep this extremely light-weight since `/api/docs/:id` is polled by the doc page.
    const receivedViaRequestProjectIdRaw = (docLean as unknown as { receivedViaRequestProjectId?: unknown })
      .receivedViaRequestProjectId;
    const isReceivedViaRequest = Boolean(receivedViaRequestProjectIdRaw);
    const replaceUploadTokenRaw = (docLean as unknown as { replaceUploadToken?: unknown }).replaceUploadToken;
    const hasReplaceUploadToken = typeof replaceUploadTokenRaw === "string" && replaceUploadTokenRaw.trim().length > 0;
    if (isReceivedViaRequest && !hasReplaceUploadToken) {
      // Very low collision probability, but handle duplicate-key errors defensively.
      for (let i = 0; i < 2; i++) {
        const candidate = newReplaceUploadToken();
        try {
          const result = await DocModel.updateOne(
            {
              _id: docObjectId,
              receivedViaRequestProjectId: { $exists: true, $ne: null },
              $or: [{ replaceUploadToken: { $exists: false } }, { replaceUploadToken: null }, { replaceUploadToken: "" }],
            },
            { $set: { replaceUploadToken: candidate } },
          );
          // If we updated, mirror it into the in-memory doc instance so the response includes it
          // without requiring an extra re-fetch.
          if ((result as unknown as { modifiedCount?: unknown }).modifiedCount) {
            (docLean as unknown as { replaceUploadToken?: string }).replaceUploadToken = candidate;
          }
          break;
        } catch (e) {
          // Duplicate token; retry once.
          if (e && typeof e === "object" && "code" in e && (e as { code?: number }).code === 11000) continue;
          throw e;
        }
      }
    }

    if (!docLean) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const currentUploadId = (docLean as any).currentUploadId ?? (docLean as any).uploadId ?? null;

    const uploadPromise = currentUploadId ? UploadModel.findById(currentUploadId).lean() : Promise.resolve(null);

    // Best-effort: resolve who uploaded the current version.
    const lastUpload = (function () {
      // placeholder, computed after upload resolves
      return null as null | {
        version: number | null;
        uploadedAt: string | null;
        uploadedByUserId: string | null;
      };
    })();

    const upload = lite ? null : await uploadPromise;

    // In `lite=1` mode we avoid hydrating the full Upload, but the doc page still needs the
    // current version number to render the `vN` badge/link in the top bar.
    let currentUploadVersion: number | null =
      upload && Number.isFinite((upload as any).version) ? Number((upload as any).version) : null;
    if (lite && currentUploadId) {
      try {
        const v = await UploadModel.findById(currentUploadId).select({ version: 1 }).lean();
        const next = v && Number.isFinite((v as any).version) ? Number((v as any).version) : null;
        if (typeof next === "number") currentUploadVersion = next;
      } catch {
        // ignore; keep version null
      }
    }

    const lastUploadResolved = (function () {
      if (lite) return null;
      if (!upload || typeof upload !== "object") return null;
      const v = Number.isFinite((upload as any).version) ? Number((upload as any).version) : null;
      const createdDate = (upload as any).createdDate instanceof Date ? (upload as any).createdDate : null;
      const uploaderIdRaw = (upload as any).userId ? String((upload as any).userId) : "";
      const uploaderId = uploaderIdRaw && Types.ObjectId.isValid(uploaderIdRaw) ? uploaderIdRaw : null;
      return {
        version: v,
        uploadedAt: createdDate ? createdDate.toISOString() : null,
        uploadedByUserId: uploaderId,
      };
    })();

    const lastUploadedBy =
      !lite && lastUploadResolved?.uploadedByUserId
        ? await UserModel.findById(new Types.ObjectId(lastUploadResolved.uploadedByUserId))
            .select({ _id: 1, name: 1, email: 1, isTemp: 1 })
            .lean()
        : null;

    const projectIdsRaw = (docLean as unknown as { projectIds?: unknown }).projectIds;
    const projectIds = Array.isArray(projectIdsRaw)
      ? projectIdsRaw.filter((x) => Types.ObjectId.isValid(String(x))).map((x) => new Types.ObjectId(String(x)))
      : [];
    const primaryProjectId = docLean.projectId ? new Types.ObjectId(String(docLean.projectId)) : null;
    const allProjectIds = [
      ...(primaryProjectId ? [primaryProjectId] : []),
      ...projectIds,
    ];
    const uniqueProjectIds = Array.from(new Map(allProjectIds.map((id) => [String(id), id])).values());

    const projects =
      uniqueProjectIds.length
        ? await ProjectModel.find({ _id: { $in: uniqueProjectIds }, orgId })
            .select({ _id: 1, name: 1, slug: 1, isRequest: 1, requestReviewEnabled: 1 })
            .lean()
        : [];

    const isInRequestRepo = projects.some((p) =>
      Boolean((p as unknown as { isRequest?: unknown }).isRequest),
    );

    let repairedFromCompletedUpload = false;

    /**
     * Repair stuck docs on read (replacement uploads).
     *
     * We've seen rare cases where an Upload finishes (`status=completed`) but the Doc record
     * remains in `preparing` (or has stale artifact pointers). This is especially painful for
     * "replace file" because the UI + PDF proxy rely on Doc fields (`status`, `blobUrl`, etc).
     *
     * For non-request docs only, if the current upload is already completed, re-sync the Doc
     * to the Upload's canonical artifacts. This is idempotent and keeps the UI responsive even
     * if a background worker update was interrupted.
     */
    if (
      !lite &&
      upload &&
      (upload as { status?: unknown }).status === "completed" &&
      !isInRequestRepo &&
      !docLean.receivedViaRequestProjectId &&
      (docLean.status !== "ready" ||
        String(docLean.currentUploadId ?? docLean.uploadId ?? "") !== String((upload as any)._id ?? "") ||
        (typeof docLean.blobUrl === "string" && typeof (upload as any).blobUrl === "string"
          ? docLean.blobUrl !== (upload as any).blobUrl
          : false))
    ) {
      const isReplacement = Number.isFinite((upload as any).version) && Number((upload as any).version) > 1;
      const nextPreviewFromUpload = (upload as any).previewImageUrl ?? (upload as any).firstPagePngUrl ?? null;
      // IMPORTANT: for replacement uploads, never wipe an existing doc preview
      // if the upload didn't generate one (best-effort preview rendering can fail).
      const nextPreview =
        nextPreviewFromUpload ?? (isReplacement ? (docLean.previewImageUrl ?? docLean.firstPagePngUrl ?? null) : null);
      const nextText = (upload as any).rawExtractedText ?? (upload as any).pdfText ?? null;

      await DocModel.updateOne(
        { ...docMatch },
        {
          $set: {
            status: "ready",
            blobUrl: (upload as any).blobUrl ?? docLean.blobUrl ?? null,
            currentUploadId: (upload as any)._id,
            uploadId: (upload as any)._id, // backward compat
            previewImageUrl: nextPreview,
            firstPagePngUrl: nextPreview, // compat
            extractedText: nextText,
            pdfText: nextText, // compat
            aiOutput: (upload as any).aiOutput ?? (isReplacement ? docLean.aiOutput ?? null : null),
            docName: (upload as any).docName ?? (isReplacement ? docLean.docName ?? null : null),
            pageSlugs: Array.isArray((upload as any).pageSlugs)
              ? (upload as any).pageSlugs
              : (isReplacement ? (docLean.pageSlugs ?? []) : []),
          },
        },
      );
      repairedFromCompletedUpload = true;

      // Update the in-memory snapshot we use for the response so the client sees the fix immediately.
      docLean.status = "ready";
      docLean.blobUrl = (upload as any).blobUrl ?? docLean.blobUrl ?? null;
      (docLean as any).currentUploadId = (upload as any)._id;
      (docLean as any).uploadId = (upload as any)._id;
      docLean.previewImageUrl = nextPreview;
      docLean.firstPagePngUrl = nextPreview;
      docLean.extractedText = nextText;
      docLean.pdfText = nextText;
      docLean.aiOutput = (upload as any).aiOutput ?? (isReplacement ? docLean.aiOutput ?? null : null);
      (docLean as any).docName = (upload as any).docName ?? (isReplacement ? (docLean as any).docName ?? null : null);
      (docLean as any).pageSlugs = Array.isArray((upload as any).pageSlugs)
        ? (upload as any).pageSlugs
        : (isReplacement ? (docLean as any).pageSlugs ?? [] : []);
    }

    // Best-effort: if this doc is a request guide doc, provide the request repo id even if
    // older docs aren't backfilled with `guideForRequestProjectId` yet.
    let guideForRequestProjectId: string | null = null;
    try {
      const raw = (docLean as unknown as { guideForRequestProjectId?: unknown }).guideForRequestProjectId;
      guideForRequestProjectId = raw ? String(raw) : null;
      // Keep lite reads very cheap: don't do an extra Project lookup just to infer guide backlinks.
      if (!lite && !guideForRequestProjectId) {
        const reqProject = await ProjectModel.findOne({
          ...(allowLegacyByUserId
            ? {
                $or: [
                  { orgId },
                  { userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
                ],
              }
            : { orgId }),
          isDeleted: { $ne: true },
          requestReviewGuideDocId: new Types.ObjectId(docId),
          $or: [{ isRequest: true }, { requestUploadToken: { $exists: true, $nin: [null, ""] } }],
        })
          .select({ _id: 1 })
          .lean();
        guideForRequestProjectId = reqProject ? String(reqProject._id) : null;
      }
    } catch {
      guideForRequestProjectId = null;
    }

    const primaryProject =
      (primaryProjectId
        ? projects.find((p) => String(p._id) === String(primaryProjectId))
        : null) ?? (projects[0] ?? null);

    const response: Record<string, unknown> = {
      doc: {
        id: String(docLean._id),
        shareId: docLean.shareId ?? null,
        title: docLean.title ?? null,
        docName: docLean.docName ?? null,
        fileName: docLean.fileName ?? null,
        pageSlugs: docLean.pageSlugs ?? [],
        status: docLean.status ?? "draft",
        projectId: primaryProject ? String(primaryProject._id) : null,
        project: primaryProject
          ? {
              id: String(primaryProject._id),
              name: primaryProject.name ?? "",
              isRequest: Boolean((primaryProject as unknown as { isRequest?: unknown }).isRequest),
              requestReviewEnabled: Boolean(
                (primaryProject as unknown as { requestReviewEnabled?: unknown }).requestReviewEnabled,
              ),
            }
          : null,
        projectIds: projects.map((p) => String(p._id)),
        projects: projects.map((p) => ({
          id: String(p._id),
          name: p.name ?? "",
          slug: (p as unknown as { slug?: unknown }).slug ?? "",
          isRequest: Boolean((p as unknown as { isRequest?: unknown }).isRequest),
          requestReviewEnabled: Boolean((p as unknown as { requestReviewEnabled?: unknown }).requestReviewEnabled),
        })),
        isArchived: Boolean(docLean.isArchived),
        currentUploadId: currentUploadId ? String(currentUploadId) : null,
        currentUploadVersion,
        blobUrl: docLean.blobUrl ?? null,
        previewImageUrl:
          docLean.previewImageUrl ?? docLean.firstPagePngUrl ?? null,
        extractedText: lite ? null : (docLean.extractedText ?? docLean.pdfText ?? null),
        aiOutput: docLean.aiOutput ?? null,
        receiverRelevanceChecklist: Boolean(docLean.receiverRelevanceChecklist),
        shareAllowPdfDownload: Boolean((docLean as unknown as { shareAllowPdfDownload?: unknown }).shareAllowPdfDownload),
        shareAllowRevisionHistory: Boolean(
          (docLean as unknown as { shareAllowRevisionHistory?: unknown }).shareAllowRevisionHistory,
        ),
        sharePasswordEnabled: Boolean(docLean.sharePasswordHash),
        receivedViaRequestProjectId: (function () {
          const raw = (docLean as unknown as { receivedViaRequestProjectId?: unknown }).receivedViaRequestProjectId;
          return raw ? String(raw) : null;
        })(),
        replaceUploadToken: (function () {
          const raw = (docLean as unknown as { replaceUploadToken?: unknown }).replaceUploadToken;
          return typeof raw === "string" && raw.trim() ? raw.trim() : null;
        })(),
        guideForRequestProjectId,
        metricsSnapshot: (function () {
          const ms = (docLean as unknown as { metricsSnapshot?: unknown }).metricsSnapshot;
          if (!ms || typeof ms !== "object") return null;
          const m = ms as {
            updatedAt?: unknown;
            days?: unknown;
            lastDaysViews?: unknown;
            lastDaysDownloads?: unknown;
            downloadsTotal?: unknown;
          };
          const updatedAt =
            m.updatedAt instanceof Date
              ? m.updatedAt.toISOString()
              : typeof m.updatedAt === "string"
                ? m.updatedAt
                : null;
          return {
            updatedAt,
            days: typeof m.days === "number" && Number.isFinite(m.days) ? m.days : null,
            lastDaysViews:
              typeof m.lastDaysViews === "number" && Number.isFinite(m.lastDaysViews) ? m.lastDaysViews : 0,
            lastDaysDownloads:
              typeof m.lastDaysDownloads === "number" && Number.isFinite(m.lastDaysDownloads) ? m.lastDaysDownloads : 0,
            downloadsTotal:
              typeof m.downloadsTotal === "number" && Number.isFinite(m.downloadsTotal) ? m.downloadsTotal : 0,
          };
        })(),
        lastUpdate: {
          version: lastUploadResolved?.version ?? null,
          uploadedAt: lastUploadResolved?.uploadedAt ?? null,
          uploadedBy: lastUploadedBy
            ? {
                id: String((lastUploadedBy as any)._id),
                name: typeof (lastUploadedBy as any).name === "string" ? (lastUploadedBy as any).name : null,
                email: typeof (lastUploadedBy as any).email === "string" ? (lastUploadedBy as any).email : null,
              }
            : null,
        },
      },
      upload: upload
        ? {
            id: String(upload._id),
            docId: upload.docId ? String(upload.docId) : null,
            version: Number.isFinite(upload.version) ? upload.version : null,
            status: upload.status ?? null,
            blobUrl: upload.blobUrl ?? null,
            previewImageUrl:
              upload.previewImageUrl ?? upload.firstPagePngUrl ?? null,
            rawExtractedText: lite ? null : (upload.rawExtractedText ?? upload.pdfText ?? null),
            aiOutput: upload.aiOutput ?? null,
            ...(function () {
              const u = upload as unknown as Record<string, unknown>;
              const docName = typeof u.docName === "string" ? u.docName : null;
              const pageSlugs = Array.isArray(u.pageSlugs) ? u.pageSlugs : [];
              return { docName, pageSlugs };
            })(),
            error: upload.error ?? null,
          }
        : null,
    };

    if (includeDebug) {
      // One-line snapshot log so we can correlate client stuck states with server truth quickly.
      debugLog(1, "[api/docs/:docId] debug snapshot", {
        docId,
        actorKind: actor.kind,
        orgId: actor.orgId,
        personalOrgId: actor.personalOrgId,
        allowLegacyByUserId,
        isInRequestRepo,
        repairedFromCompletedUpload,
        docStatus: (docLean as any).status ?? null,
        docCurrentUploadId: (docLean as any).currentUploadId ? String((docLean as any).currentUploadId) : null,
        docBlobUrl: typeof (docLean as any).blobUrl === "string" ? "[set]" : null,
        uploadStatus: upload ? ((upload as any).status ?? null) : null,
        uploadVersion: upload && Number.isFinite((upload as any).version) ? Number((upload as any).version) : null,
        uploadBlobUrl: upload && typeof (upload as any).blobUrl === "string" ? "[set]" : null,
      });

      response.debug = {
        enabled: true,
        doc: docLean,
        currentUpload: upload,
        ...(wantsDebugUploads
          ? {
              uploads: await UploadModel.find({
                docId: new Types.ObjectId(docId),
                isDeleted: { $ne: true },
              })
                .sort({ createdDate: -1 })
                .lean(),
            }
          : {}),
        derived: {
          isInRequestRepo,
          repairedFromCompletedUpload,
        },
      };
    }

    return applyTempUserHeaders(NextResponse.json(response, { headers: { "cache-control": "no-store" } }), actor);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/docs/:docId] GET failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
/**
 * Handle PATCH requests.
 */


export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ docId: string }> },
) {
  try {
    const { docId } = await ctx.params;
    if (!isObjectId(docId)) {
      return NextResponse.json({ error: "Invalid docId" }, { status: 400 });
    }

    debugLog(1, "[api/docs/:docId] PATCH", { docId });
    const actor = await resolveActor(request);
    const body = (await request.json().catch(() => ({}))) as Partial<{
      status: "draft" | "preparing" | "ready" | "failed";
      currentUploadId: string | null;
      title: string;
      blobUrl: string | null;
      previewImageUrl: string | null;
      extractedText: string | null;
      receiverRelevanceChecklist: boolean;
      shareAllowPdfDownload: boolean;
      shareAllowRevisionHistory: boolean;
      addProjectId: string;
      removeProjectId: string;
      projectId: string | null;
      isArchived: boolean;
    }>;

    await connectMongo();

    const docObjectId = new Types.ObjectId(docId);
    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
    const docMatch = allowLegacyByUserId
      ? {
          $or: [
            { _id: docObjectId, orgId },
            { _id: docObjectId, userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
          ],
        }
      : { _id: docObjectId, orgId };

    const setFields: Record<string, unknown> = {};
    const addToSetFields: Record<string, unknown> = {};
    const pullFields: Record<string, unknown> = {};

    if (typeof body.title === "string") setFields.title = body.title;
    if (typeof body.status === "string") setFields.status = body.status;
    if (typeof body.blobUrl === "string" || body.blobUrl === null) setFields.blobUrl = body.blobUrl;
    if (typeof body.previewImageUrl === "string" || body.previewImageUrl === null)
      setFields.previewImageUrl = body.previewImageUrl;
    if (typeof body.extractedText === "string" || body.extractedText === null)
      setFields.extractedText = body.extractedText;
    if (typeof body.receiverRelevanceChecklist === "boolean") {
      setFields.receiverRelevanceChecklist = body.receiverRelevanceChecklist;
    }
    if (typeof body.shareAllowPdfDownload === "boolean") {
      setFields.shareAllowPdfDownload = body.shareAllowPdfDownload;
    }
    if (typeof body.shareAllowRevisionHistory === "boolean") {
      setFields.shareAllowRevisionHistory = body.shareAllowRevisionHistory;
    }

    if (typeof body.isArchived === "boolean") {
      setFields.isArchived = body.isArchived;
      setFields.archivedDate = body.isArchived ? new Date() : null;
    }

    // Project membership changes need current state for primary selection.
    const wantsProjectChange =
      typeof body.projectId !== "undefined" ||
      typeof body.addProjectId === "string" ||
      typeof body.removeProjectId === "string";

    const before = wantsProjectChange
      ? await DocModel.findOne({ ...docMatch })
          .select({ _id: 1, projectId: 1, projectIds: 1 })
          .lean()
      : null;

    if (wantsProjectChange && !before) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Legacy behavior: setting `projectId` still works, but also updates membership list.
    if (typeof body.projectId === "string") {
      if (!Types.ObjectId.isValid(body.projectId)) {
        return NextResponse.json({ error: "Invalid projectId" }, { status: 400 });
      }
      const pid = new Types.ObjectId(body.projectId);
      setFields.projectId = pid;
      addToSetFields.projectIds = pid;
    } else if (body.projectId === null) {
      // Backward-compat: "remove from project" historically meant remove from all projects.
      setFields.projectId = null;
      setFields.projectIds = [];
    }

    if (typeof body.addProjectId === "string") {
      if (!Types.ObjectId.isValid(body.addProjectId)) {
        return NextResponse.json({ error: "Invalid addProjectId" }, { status: 400 });
      }
      const addId = new Types.ObjectId(body.addProjectId);
      if (typeof addToSetFields.projectIds === "undefined") addToSetFields.projectIds = addId;
      // If we have no explicit primary change and the doc currently has no primary, set it.
      if (
        typeof setFields.projectId === "undefined" &&
        before &&
        !before.projectId
      ) {
        setFields.projectId = addId;
      }
    }

    let removedPrimary = false;
    if (typeof body.removeProjectId === "string") {
      if (!Types.ObjectId.isValid(body.removeProjectId)) {
        return NextResponse.json({ error: "Invalid removeProjectId" }, { status: 400 });
      }
      const removeId = new Types.ObjectId(body.removeProjectId);
      pullFields.projectIds = removeId;
      // If we're removing the current primary (and not explicitly setting a new one), clear primary for now.
      if (
        before &&
        before.projectId &&
        String(before.projectId) === String(removeId) &&
        typeof setFields.projectId === "undefined"
      ) {
        setFields.projectId = null;
        removedPrimary = true;
      }
    }

    if (typeof body.currentUploadId === "string" || body.currentUploadId === null) {
      const nextUploadId =
        typeof body.currentUploadId === "string" && body.currentUploadId
          ? new Types.ObjectId(body.currentUploadId)
          : null;
      setFields.currentUploadId = nextUploadId;
      // keep backward compat field in sync
      setFields.uploadId = nextUploadId;
    }

    const updateDoc: Record<string, unknown> = {};
    if (Object.keys(setFields).length) updateDoc.$set = setFields;
    if (Object.keys(addToSetFields).length) updateDoc.$addToSet = addToSetFields;
    if (Object.keys(pullFields).length) updateDoc.$pull = pullFields;

    const doc = await DocModel.findOneAndUpdate(
      { ...docMatch },
      updateDoc,
      { new: true },
    ).lean();
    if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // If we removed the primary, pick a new primary from remaining membership (best-effort).
    if (removedPrimary) {
      const remaining = Array.isArray((doc as unknown as { projectIds?: unknown }).projectIds)
        ? ((doc as unknown as { projectIds?: unknown }).projectIds as unknown[]).map((x) => String(x))
        : [];
      const nextPrimary = remaining[0] && Types.ObjectId.isValid(remaining[0]) ? new Types.ObjectId(remaining[0]) : null;
      await DocModel.updateOne(
        { ...docMatch },
        { $set: { projectId: nextPrimary } },
      );
      (doc as unknown as { projectId?: unknown }).projectId = nextPrimary;
    }

    // Project.docCount is maintained at the model level (Doc middleware).

    const docProjectIdsRaw = (doc as unknown as { projectIds?: unknown }).projectIds;
    const docProjectIds = Array.isArray(docProjectIdsRaw)
      ? docProjectIdsRaw
          .filter((x) => Types.ObjectId.isValid(String(x)))
          .map((x) => new Types.ObjectId(String(x)))
      : [];
    const docPrimaryProjectId = doc.projectId ? new Types.ObjectId(String(doc.projectId)) : null;
    const uniqueDocProjectIds = Array.from(
      new Map(
        [
          ...(docPrimaryProjectId ? [docPrimaryProjectId] : []),
          ...docProjectIds,
        ].map((id) => [String(id), id]),
      ).values(),
    );

    const projects =
      uniqueDocProjectIds.length
        ? await ProjectModel.find({ _id: { $in: uniqueDocProjectIds }, orgId })
            .select({ _id: 1, name: 1, slug: 1 })
            .lean()
        : [];
    const primaryProject =
      (docPrimaryProjectId
        ? projects.find((p) => String(p._id) === String(docPrimaryProjectId))
        : null) ?? (projects[0] ?? null);

    return applyTempUserHeaders(
      NextResponse.json(
        {
        doc: {
          id: String(doc._id),
          shareId: doc.shareId ?? null,
          title: doc.title ?? null,
          docName: doc.docName ?? null,
          fileName: doc.fileName ?? null,
          pageSlugs: doc.pageSlugs ?? [],
          status: doc.status ?? "draft",
          projectId: primaryProject ? String(primaryProject._id) : null,
          project: primaryProject ? { id: String(primaryProject._id), name: primaryProject.name ?? "" } : null,
          projectIds: projects.map((p) => String(p._id)),
          projects: projects.map((p) => ({
            id: String(p._id),
            name: p.name ?? "",
            slug: (p as unknown as { slug?: unknown }).slug ?? "",
          })),
          isArchived: Boolean(doc.isArchived),
          currentUploadId: doc.currentUploadId ? String(doc.currentUploadId) : null,
          blobUrl: doc.blobUrl ?? null,
          previewImageUrl:
            doc.previewImageUrl ?? doc.firstPagePngUrl ?? null,
          extractedText: doc.extractedText ?? doc.pdfText ?? null,
          aiOutput: doc.aiOutput ?? null,
          receiverRelevanceChecklist: Boolean(doc.receiverRelevanceChecklist),
          sharePasswordEnabled: Boolean((doc as unknown as { sharePasswordHash?: unknown }).sharePasswordHash),
          shareAllowPdfDownload: Boolean((doc as unknown as { shareAllowPdfDownload?: unknown }).shareAllowPdfDownload),
          shareAllowRevisionHistory: Boolean(
            (doc as unknown as { shareAllowRevisionHistory?: unknown }).shareAllowRevisionHistory,
          ),
        },
        },
        { headers: { "cache-control": "no-store" } },
      ),
      actor,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/docs/:docId] PATCH failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
/**
 * Handle DELETE requests.
 */


export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ docId: string }> },
) {
  try {
    const { docId } = await ctx.params;
    if (!isObjectId(docId)) {
      return NextResponse.json({ error: "Invalid docId" }, { status: 400 });
    }

    debugLog(1, "[api/docs/:docId] DELETE", { docId });
    const actor = await resolveActor(request);
    await connectMongo();

    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
    const docObjectId = new Types.ObjectId(docId);
    const docMatch = allowLegacyByUserId
      ? {
          $or: [
            { _id: docObjectId, orgId },
            { _id: docObjectId, userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
          ],
        }
      : { _id: docObjectId, orgId };

    const res = await DocModel.updateOne(
      { ...docMatch },
      {
        $set: { isDeleted: true, deletedDate: new Date(), isDeletedDate: new Date() },
      },
    );
    if (!res.matchedCount) return NextResponse.json({ error: "Not found" }, { status: 404 });

    return applyTempUserHeaders(NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } }), actor);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/docs/:docId] DELETE failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

