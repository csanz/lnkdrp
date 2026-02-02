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
import { applyTempUserHeaders, resolveActor, tryResolveUserActorFastWithPersonalOrg } from "@/lib/gating/actor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/**
 * Generates a Base62 string using cryptographic randomness.
 *
 * Exists to mint share IDs and capability tokens without leaking sequential patterns.
 * Assumptions: collisions are extremely unlikely but callers should still handle dupes.
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
 * Validates that a string is a Mongo ObjectId.
 *
 * Exists to reject malformed route params early with consistent 400 responses.
 */
function isObjectId(id: string) {
  return Types.ObjectId.isValid(id);
}

/**
 * Builds the doc match query for org-scoped access with legacy personal-doc fallback.
 *
 * Exists to reduce duplication across GET/PATCH/DELETE handlers.
 */
function buildDocMatch(
  docObjectId: Types.ObjectId,
  orgId: Types.ObjectId,
  legacyUserId: Types.ObjectId,
  allowLegacyByUserId: boolean,
) {
  return allowLegacyByUserId
    ? {
        $or: [
          { _id: docObjectId, orgId },
          { _id: docObjectId, userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
        ],
      }
    : { _id: docObjectId, orgId };
}

/**
 * Generates a short public identifier for `/s/:shareId`.
 *
 * This is not secret; it is a URL slug. Callers must handle rare collisions on insert/update.
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
 * `GET /api/docs/:docId`
 *
 * Returns doc details for the active workspace, including lightweight "lite=1" mode for hot UI paths.
 * Side effects: may best-effort backfill `orgId`, ensure `shareId`, ensure request `replaceUploadToken`,
 * and repair stale doc artifacts when the current upload is already completed.
 * Errors: 400 for invalid params/processing failures, 404 when doc not found, 401 when unauthenticated.
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
    // Hot path (doc detail + modals): avoid heavy resolver; preserve correct personalOrgId for legacy scoping.
    const actor = (await tryResolveUserActorFastWithPersonalOrg(request)) ?? (await resolveActor(request));
    await connectMongo();
    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
    const docObjectId = new Types.ObjectId(docId);
    const docMatch = buildDocMatch(docObjectId, orgId, legacyUserId, allowLegacyByUserId);

    // Fetch doc (lean) so we don't pay for a full Mongoose document instance on this hot path.
    // NOTE: We still do a few best-effort backfills below; keep them lightweight.
    const docQuery = DocModel.findOne({ ...docMatch });
    // Perf: `lite=1` must not pull huge fields (extractedText / full aiOutput JSON).
    // Only fetch the minimal snapshot fields used by the doc UI + share panel.
    if (lite) {
      docQuery.select({
        _id: 1,
        orgId: 1,
        userId: 1,
        shareId: 1,
        title: 1,
        docName: 1,
        fileName: 1,
        pageSlugs: 1,
        status: 1,
        primaryProjectId: 1,
        projectId: 1,
        projectIds: 1,
        isArchived: 1,
        currentUploadId: 1,
        uploadId: 1, // legacy
        blobUrl: 1,
        previewImageUrl: 1,
        firstPagePngUrl: 1,
        receiverRelevanceChecklist: 1,
        shareAllowPdfDownload: 1,
        shareEnabled: 1,
        shareAllowRevisionHistory: 1,
        sharePasswordHash: 1,
        receivedViaRequestProjectId: 1,
        replaceUploadToken: 1,
        guideForRequestProjectId: 1,
        metricsSnapshot: 1,
        // AI Snapshot fields used by `DocSharePanel` + doc summary badges.
        "aiOutput.company_or_project_name": 1,
        "aiOutput.one_liner": 1,
        "aiOutput.core_problem_or_need": 1,
        "aiOutput.primary_capabilities_or_scope": 1,
        "aiOutput.intended_use_or_context": 1,
        "aiOutput.outcomes_or_value": 1,
        "aiOutput.maturity_or_status": 1,
        "aiOutput.ask": 1,
        "aiOutput.key_metrics": 1,
        "aiOutput.summary": 1,
        "aiOutput.tags": 1,
      });
    }
    let docLean = await docQuery.lean();
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
      if (!ensured || !(docLean as any)?.shareId) {
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

    const upload = lite ? null : await uploadPromise;
    // In `lite=1` mode we avoid fetching heavy text fields, but we still need:
    // - upload `version` for the `vN` badge
    // - upload `blobUrl` / preview fields to avoid "blank" doc pages when the Doc record is missing artifacts
    // - upload `status` so we can safely repair stale Doc pointers when the upload is completed
    const shouldFetchUploadLite =
      lite &&
      Boolean(currentUploadId) &&
      (docLean.status !== "ready" ||
        !(typeof (docLean as any).blobUrl === "string" && (docLean as any).blobUrl) ||
        !(
          (typeof (docLean as any).previewImageUrl === "string" && (docLean as any).previewImageUrl) ||
          (typeof (docLean as any).firstPagePngUrl === "string" && (docLean as any).firstPagePngUrl)
        ));
    const uploadLite = shouldFetchUploadLite
      ? await UploadModel.findById(currentUploadId)
          .select({
            _id: 1,
            version: 1,
            status: 1,
            blobUrl: 1,
            previewImageUrl: 1,
            firstPagePngUrl: 1,
            createdDate: 1,
            userId: 1,
          })
          .lean()
      : lite && currentUploadId
        ? await UploadModel.findById(currentUploadId).select({ _id: 1, version: 1, createdDate: 1, userId: 1 }).lean()
        : null;

    // In `lite=1` mode we avoid hydrating the full Upload, but the doc page still needs the
    // current version number to render the `vN` badge/link in the top bar.
    const currentUploadVersion: number | null =
      upload && Number.isFinite((upload as any).version)
        ? Number((upload as any).version)
        : uploadLite && Number.isFinite((uploadLite as any).version)
          ? Number((uploadLite as any).version)
          : null;

    const uploadForLastUpdate = lite ? uploadLite : upload;
    const lastUploadResolved = (function () {
      if (!uploadForLastUpdate || typeof uploadForLastUpdate !== "object") return null;
      const v = Number.isFinite((uploadForLastUpdate as any).version) ? Number((uploadForLastUpdate as any).version) : null;
      const createdDate = (uploadForLastUpdate as any).createdDate instanceof Date ? (uploadForLastUpdate as any).createdDate : null;
      const uploaderIdRaw = (uploadForLastUpdate as any).userId ? String((uploadForLastUpdate as any).userId) : "";
      const uploaderId = uploaderIdRaw && Types.ObjectId.isValid(uploaderIdRaw) ? uploaderIdRaw : null;
      return {
        version: v,
        uploadedAt: createdDate ? createdDate.toISOString() : null,
        uploadedByUserId: uploaderId,
      };
    })();

    const lastUploadedBy =
      lastUploadResolved?.uploadedByUserId
        ? await UserModel.findById(new Types.ObjectId(lastUploadResolved.uploadedByUserId))
            .select({ _id: 1, name: 1, email: 1, isTemp: 1 })
            .lean()
        : null;

    const projectIdsRaw = (docLean as unknown as { projectIds?: unknown }).projectIds;
    const projectIds = Array.isArray(projectIdsRaw)
      ? projectIdsRaw.filter((x) => Types.ObjectId.isValid(String(x))).map((x) => new Types.ObjectId(String(x)))
      : [];
    const primaryProjectId =
      (docLean as unknown as { primaryProjectId?: unknown }).primaryProjectId && Types.ObjectId.isValid(String((docLean as any).primaryProjectId))
        ? new Types.ObjectId(String((docLean as any).primaryProjectId))
        : docLean.projectId
          ? new Types.ObjectId(String(docLean.projectId))
          : null;
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
    const uploadForRepair = (lite ? uploadLite : upload) as any;
    if (
      uploadForRepair &&
      (uploadForRepair as { status?: unknown }).status === "completed" &&
      !isInRequestRepo &&
      !docLean.receivedViaRequestProjectId
    ) {
      const needsArtifactRepair =
        docLean.status !== "ready" ||
        String(docLean.currentUploadId ?? docLean.uploadId ?? "") !== String(uploadForRepair._id ?? "") ||
        (!docLean.blobUrl && typeof uploadForRepair.blobUrl === "string" && uploadForRepair.blobUrl) ||
        (!docLean.previewImageUrl &&
          !docLean.firstPagePngUrl &&
          (typeof uploadForRepair.previewImageUrl === "string" ||
            typeof uploadForRepair.firstPagePngUrl === "string"));

      if (needsArtifactRepair) {
        const isReplacement = Number.isFinite(uploadForRepair.version) && Number(uploadForRepair.version) > 1;
        const nextPreviewFromUpload = uploadForRepair.previewImageUrl ?? uploadForRepair.firstPagePngUrl ?? null;
      // IMPORTANT: for replacement uploads, never wipe an existing doc preview
      // if the upload didn't generate one (best-effort preview rendering can fail).
      const nextPreview =
        nextPreviewFromUpload ?? (isReplacement ? (docLean.previewImageUrl ?? docLean.firstPagePngUrl ?? null) : null);
        const nextText = lite ? null : (uploadForRepair as any).rawExtractedText ?? (uploadForRepair as any).pdfText ?? null;

        await DocModel.updateOne(
          { ...docMatch },
          {
            $set: {
              status: "ready",
              blobUrl: uploadForRepair.blobUrl ?? docLean.blobUrl ?? null,
              currentUploadId: uploadForRepair._id,
              uploadId: uploadForRepair._id, // backward compat
              previewImageUrl: nextPreview,
              firstPagePngUrl: nextPreview, // compat
              ...(lite
                ? null
                : {
                    extractedText: nextText,
                    pdfText: nextText, // compat
                    aiOutput: (uploadForRepair as any).aiOutput ?? (isReplacement ? docLean.aiOutput ?? null : null),
                    docName: (uploadForRepair as any).docName ?? (isReplacement ? docLean.docName ?? null : null),
                    pageSlugs: Array.isArray((uploadForRepair as any).pageSlugs)
                      ? (uploadForRepair as any).pageSlugs
                      : (isReplacement ? (docLean.pageSlugs ?? []) : []),
                  }),
            },
          },
        );
        repairedFromCompletedUpload = true;

        // Update the in-memory snapshot we use for the response so the client sees the fix immediately.
        docLean.status = "ready";
        docLean.blobUrl = uploadForRepair.blobUrl ?? docLean.blobUrl ?? null;
        (docLean as any).currentUploadId = uploadForRepair._id;
        (docLean as any).uploadId = uploadForRepair._id;
        docLean.previewImageUrl = nextPreview;
        docLean.firstPagePngUrl = nextPreview;
        if (!lite) {
          docLean.extractedText = nextText;
          docLean.pdfText = nextText;
          docLean.aiOutput = (uploadForRepair as any).aiOutput ?? (isReplacement ? docLean.aiOutput ?? null : null);
          (docLean as any).docName =
            (uploadForRepair as any).docName ?? (isReplacement ? (docLean as any).docName ?? null : null);
          (docLean as any).pageSlugs = Array.isArray((uploadForRepair as any).pageSlugs)
            ? (uploadForRepair as any).pageSlugs
            : (isReplacement ? (docLean as any).pageSlugs ?? [] : []);
        }
      }
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
        primaryProjectId: primaryProject ? String(primaryProject._id) : null,
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
        // Default to enabled for legacy docs that don't have the field yet.
        shareEnabled: (docLean as unknown as { shareEnabled?: unknown }).shareEnabled !== false,
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
                .limit(50)
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
    // Use 500 for unexpected internal errors; validation errors are caught earlier with 400
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * `PATCH /api/docs/:docId`
 *
 * Applies user-scoped updates to doc metadata (title/status/share settings/project membership/archive state).
 * Side effects: may update project membership fields and keep legacy pointers (`uploadId`) in sync.
 * Errors: 400 for invalid IDs/body, 404 when doc not found.
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
      shareEnabled: boolean;
      shareAllowRevisionHistory: boolean;
      addProjectId: string;
      removeProjectId: string;
      primaryProjectId: string | null;
      projectId: string | null;
      isArchived: boolean;
    }>;

    await connectMongo();

    const docObjectId = new Types.ObjectId(docId);
    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
    const docMatch = buildDocMatch(docObjectId, orgId, legacyUserId, allowLegacyByUserId);

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
    if (typeof body.shareEnabled === "boolean") {
      setFields.shareEnabled = body.shareEnabled;
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
      typeof body.primaryProjectId !== "undefined" ||
      typeof body.projectId !== "undefined" ||
      typeof body.addProjectId === "string" ||
      typeof body.removeProjectId === "string";

    const before = wantsProjectChange
      ? await DocModel.findOne({ ...docMatch })
          .select({ _id: 1, primaryProjectId: 1, projectId: 1, projectIds: 1 })
          .lean()
      : null;

    if (wantsProjectChange && !before) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Canonical behavior: setting `primaryProjectId` sets the primary pointer and adds membership.
    if (typeof body.primaryProjectId === "string") {
      if (!Types.ObjectId.isValid(body.primaryProjectId)) {
        return NextResponse.json({ error: "Invalid primaryProjectId" }, { status: 400 });
      }
      const pid = new Types.ObjectId(body.primaryProjectId);
      setFields.primaryProjectId = pid;
      // Backward-compat: keep legacy primary pointer in sync during transition.
      setFields.projectId = pid;
      addToSetFields.projectIds = pid;
    } else if (body.primaryProjectId === null) {
      // Clear primary pointer (does not modify membership list).
      setFields.primaryProjectId = null;
      setFields.projectId = null;
    }

    // Legacy behavior: setting `projectId` still works, but also updates membership list.
    // Note: if `primaryProjectId` is provided above, it takes precedence.
    if (typeof body.projectId === "string") {
      if (!Types.ObjectId.isValid(body.projectId)) {
        return NextResponse.json({ error: "Invalid projectId" }, { status: 400 });
      }
      const pid = new Types.ObjectId(body.projectId);
      if (typeof body.primaryProjectId === "undefined") {
        setFields.primaryProjectId = pid;
        setFields.projectId = pid;
        addToSetFields.projectIds = pid;
      }
    } else if (body.projectId === null) {
      // Backward-compat: "remove from project" historically meant remove from all projects.
      setFields.primaryProjectId = null;
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
      const beforePrimary =
        before &&
        ((before as unknown as { primaryProjectId?: unknown }).primaryProjectId ?? (before as unknown as { projectId?: unknown }).projectId);
      if (
        typeof setFields.primaryProjectId === "undefined" &&
        before &&
        !beforePrimary
      ) {
        setFields.primaryProjectId = addId;
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
      const beforePrimary =
        before &&
        ((before as unknown as { primaryProjectId?: unknown }).primaryProjectId ?? (before as unknown as { projectId?: unknown }).projectId);
      if (
        before &&
        beforePrimary &&
        String(beforePrimary) === String(removeId) &&
        typeof setFields.primaryProjectId === "undefined" &&
        typeof setFields.projectId === "undefined"
      ) {
        setFields.primaryProjectId = null;
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
        { $set: { primaryProjectId: nextPrimary, projectId: nextPrimary } },
      );
      (doc as unknown as { primaryProjectId?: unknown }).primaryProjectId = nextPrimary;
      (doc as unknown as { projectId?: unknown }).projectId = nextPrimary;
    }

    // Project.docCount is maintained at the model level (Doc middleware).

    const docProjectIdsRaw = (doc as unknown as { projectIds?: unknown }).projectIds;
    const docProjectIds = Array.isArray(docProjectIdsRaw)
      ? docProjectIdsRaw
          .filter((x) => Types.ObjectId.isValid(String(x)))
          .map((x) => new Types.ObjectId(String(x)))
      : [];
    const docPrimaryProjectId =
      (doc as unknown as { primaryProjectId?: unknown }).primaryProjectId && Types.ObjectId.isValid(String((doc as any).primaryProjectId))
        ? new Types.ObjectId(String((doc as any).primaryProjectId))
        : doc.projectId
          ? new Types.ObjectId(String(doc.projectId))
          : null;
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
          primaryProjectId: primaryProject ? String(primaryProject._id) : null,
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
          // Default to enabled for legacy docs that don't have the field yet.
          shareEnabled: (doc as unknown as { shareEnabled?: unknown }).shareEnabled !== false,
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
    // Use 500 for unexpected internal errors; validation errors are caught earlier with 400
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * `DELETE /api/docs/:docId`
 *
 * Soft-deletes a doc for the active workspace (sets delete flags/dates).
 * Exists to preserve history while removing the doc from normal lists.
 * Errors: 400 for invalid docId, 404 when doc not found.
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
    const docMatch = buildDocMatch(docObjectId, orgId, legacyUserId, allowLegacyByUserId);

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
    // Use 500 for unexpected internal errors; validation errors are caught earlier with 400
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

