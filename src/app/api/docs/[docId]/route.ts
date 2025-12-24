import { NextResponse } from "next/server";
import { Types } from "mongoose";
import crypto from "node:crypto";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { ProjectModel } from "@/lib/models/Project";
import { UploadModel } from "@/lib/models/Upload";
import { debugEnabled, debugError, debugLog } from "@/lib/debug";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";

export const runtime = "nodejs";

function isObjectId(id: string) {
  return Types.ObjectId.isValid(id);
}

function newShareId() {
  return crypto.randomBytes(9).toString("base64url");
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ docId: string }> },
) {
  try {
    const url = new URL(request.url);
    const includeDebug = url.searchParams.get("debug") === "1" && debugEnabled(1);

    const { docId } = await ctx.params;
    if (!isObjectId(docId)) {
      return NextResponse.json({ error: "Invalid docId" }, { status: 400 });
    }

    debugLog(2, "[api/docs/:docId] GET", { docId, includeDebug });
    const actor = await resolveActor(request);
    await connectMongo();
    // Ensure doc has a shareId (older docs may not). Retry on rare collisions.
    let doc = await DocModel.findOne({
      _id: new Types.ObjectId(docId),
      userId: new Types.ObjectId(actor.userId),
    });
    if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (!doc.shareId) {
      let ensured = false;
      for (let i = 0; i < 5; i++) {
        const candidate = newShareId();
        try {
          const updated = await DocModel.findOneAndUpdate(
            {
              _id: new Types.ObjectId(docId),
              userId: new Types.ObjectId(actor.userId),
              shareId: { $in: [null, undefined, ""] },
            },
            { $set: { shareId: candidate } },
            { new: true },
          );
          if (updated) {
            doc = updated;
            ensured = true;
            break;
          }
          // Another request beat us to it; re-fetch and continue.
          doc = await DocModel.findOne({
            _id: new Types.ObjectId(docId),
            userId: new Types.ObjectId(actor.userId),
          });
          if (doc?.shareId) {
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

    if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const docLean = doc.toObject();

    const currentUploadId = docLean.currentUploadId ?? docLean.uploadId ?? null;

    const upload = currentUploadId
      ? await UploadModel.findById(currentUploadId).lean()
      : null;

    const userObjectId = new Types.ObjectId(actor.userId);
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
        ? await ProjectModel.find({ _id: { $in: uniqueProjectIds }, userId: userObjectId })
            .select({ _id: 1, name: 1, slug: 1 })
            .lean()
        : [];

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
        project: primaryProject ? { id: String(primaryProject._id), name: primaryProject.name ?? "" } : null,
        projectIds: projects.map((p) => String(p._id)),
        projects: projects.map((p) => ({
          id: String(p._id),
          name: p.name ?? "",
          slug: (p as unknown as { slug?: unknown }).slug ?? "",
        })),
        isArchived: Boolean(docLean.isArchived),
        currentUploadId: currentUploadId ? String(currentUploadId) : null,
        currentUploadVersion:
          upload && Number.isFinite(upload.version) ? upload.version : null,
        blobUrl: docLean.blobUrl ?? null,
        previewImageUrl:
          docLean.previewImageUrl ?? docLean.firstPagePngUrl ?? null,
        extractedText: docLean.extractedText ?? docLean.pdfText ?? null,
        aiOutput: docLean.aiOutput ?? null,
        receiverRelevanceChecklist: Boolean(docLean.receiverRelevanceChecklist),
        shareAllowPdfDownload: Boolean((docLean as unknown as { shareAllowPdfDownload?: unknown }).shareAllowPdfDownload),
        sharePasswordEnabled: Boolean(docLean.sharePasswordHash),
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
            rawExtractedText:
              upload.rawExtractedText ?? upload.pdfText ?? null,
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
      const uploads = await UploadModel.find({
        docId: new Types.ObjectId(docId),
        isDeleted: { $ne: true },
      })
        .sort({ createdDate: -1 })
        .lean();

      response.debug = {
        enabled: true,
        doc: docLean,
        currentUpload: upload,
        uploads,
      };
    }

    return applyTempUserHeaders(NextResponse.json(response), actor);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/docs/:docId] GET failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

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
      addProjectId: string;
      removeProjectId: string;
      projectId: string | null;
      isArchived: boolean;
    }>;

    await connectMongo();

    const userObjectId = new Types.ObjectId(actor.userId);
    const docObjectId = new Types.ObjectId(docId);

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
      ? await DocModel.findOne({ _id: docObjectId, userId: userObjectId })
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
      { _id: docObjectId, userId: userObjectId },
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
        { _id: docObjectId, userId: userObjectId },
        { $set: { projectId: nextPrimary } },
      );
      (doc as unknown as { projectId?: unknown }).projectId = nextPrimary;
    }

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
        ? await ProjectModel.find({ _id: { $in: uniqueDocProjectIds }, userId: userObjectId })
            .select({ _id: 1, name: 1, slug: 1 })
            .lean()
        : [];
    const primaryProject =
      (docPrimaryProjectId
        ? projects.find((p) => String(p._id) === String(docPrimaryProjectId))
        : null) ?? (projects[0] ?? null);

    return applyTempUserHeaders(
      NextResponse.json({
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
        },
      }),
      actor,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/docs/:docId] PATCH failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

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

    const res = await DocModel.updateOne(
      { _id: new Types.ObjectId(docId), userId: new Types.ObjectId(actor.userId) },
      { $set: { isDeleted: true, isDeletedDate: new Date() } },
    );
    if (!res.matchedCount) return NextResponse.json({ error: "Not found" }, { status: 404 });

    return applyTempUserHeaders(NextResponse.json({ ok: true }), actor);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/docs/:docId] DELETE failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

