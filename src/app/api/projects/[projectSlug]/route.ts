/**
 * API route for `/api/projects/:id`.
 *
 * Update/delete a project. For request repos, also supports updating request review settings.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { ProjectModel } from "@/lib/models/Project";
import { DocModel } from "@/lib/models/Doc";
import { debugError, debugLog } from "@/lib/debug";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { newShareId } from "@/lib/crypto/randomBase62";
import { requireOrgRole } from "@/lib/orgs/requireOrgRole";
import { recordActivity } from "@/lib/activity/log";
import { authOrRateLimitResponse } from "@/lib/http/errorResponse";
import { setAllProjectLinksEnabled } from "@/lib/share/projectLinks";
import { removeAllTagsFromTarget } from "@/lib/tags/service";
import { liveProjectByIdMatch } from "@/lib/projects/scope";

export const runtime = "nodejs";

const MAX_PROJECT_NAME_LENGTH = 80;

/**
 * True when another live project in the workspace has this name, ignoring letter case. The unique
 * index is case-sensitive, so "Press kit" and "press KIT" both went in and could not be told apart
 * in any list.
 */
async function projectNameTaken(orgId: Types.ObjectId, name: string, exceptId?: unknown): Promise<boolean> {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hit = await ProjectModel.exists({
    orgId,
    name: { $regex: `^${escaped}$`, $options: "i" },
    isDeleted: { $ne: true },
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  });
  return Boolean(hit);
}

function slugify(input: string) {
  return input
    .trim()
    // Fold accents to their base letter ("Série" -> "serie") instead of cutting the word in two.
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

async function ensureUniqueSlug(opts: { orgId: Types.ObjectId; legacyUserId?: Types.ObjectId; base: string }) {
  const base = opts.base || "project";
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const exists = await ProjectModel.exists({
      $or: [
        { orgId: opts.orgId, slug: candidate },
        ...(opts.legacyUserId
          ? [
              {
                userId: opts.legacyUserId,
                slug: candidate,
                $or: [{ orgId: { $exists: false } }, { orgId: null }],
              },
            ]
          : []),
      ],
    });
    if (!exists) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

async function ensureUniqueProjectName(opts: { orgId: Types.ObjectId; legacyUserId?: Types.ObjectId; base: string }) {
  const base = (opts.base || "Project").trim().slice(0, MAX_PROJECT_NAME_LENGTH) || "Project";
  for (let i = 0; i < 50; i++) {
    const suffix = i === 0 ? "" : ` (${i + 1})`;
    const candidate = (base + suffix).slice(0, MAX_PROJECT_NAME_LENGTH);
    const exists = await ProjectModel.exists({
      $or: [
        { orgId: opts.orgId, name: candidate },
        ...(opts.legacyUserId
          ? [
              {
                userId: opts.legacyUserId,
                name: candidate,
                $or: [{ orgId: { $exists: false } }, { orgId: null }],
              },
            ]
          : []),
      ],
    });
    if (!exists) return candidate;
  }
  return `${base.slice(0, Math.max(1, MAX_PROJECT_NAME_LENGTH - 10))} ${Date.now().toString(36)}`.slice(
    0,
    MAX_PROJECT_NAME_LENGTH,
  );
}

function newProjectShareId() {
  return newShareId();
}
/**
 * Escape Regex (uses replace).
 */


function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
 * Handle PATCH requests.
 */


export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ projectSlug: string }> },
) {
  try {
    const { projectSlug } = await ctx.params;
    const projectIdParam = decodeURIComponent(projectSlug).trim();

    debugLog(1, "[api/projects/:id] PATCH", { projectId: projectIdParam });
    const actor = await resolveActor(request);
    // Viewers can read a workspace but must not edit it.
    const roleCheck = await requireOrgRole({ orgId: actor.orgId, userId: actor.userId, minRole: "member" });
    if (!roleCheck.ok) {
      return applyTempUserHeaders(NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status }), actor);
    }
    const body = (await request.json().catch(() => ({}))) as Partial<{
      name: string;
      description: string;
      autoAddFiles: boolean;
      requestReviewEnabled: boolean;
      requestReviewPrompt: string;
      requestRequireAuthToUpload: boolean;
      shareEnabled: boolean;
    }>;

    // `{ shareEnabled }` on its own is a visibility toggle: it must not require or overwrite the
    // name/description/autoAddFiles the full settings form sends.
    const shareOnly = body.name === undefined && typeof body.shareEnabled === "boolean";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const autoAddFiles = typeof body.autoAddFiles === "boolean" ? body.autoAddFiles : false;
    const requestReviewEnabled =
      typeof body.requestReviewEnabled === "boolean" ? body.requestReviewEnabled : false;
    const requestReviewPrompt =
      typeof body.requestReviewPrompt === "string" ? body.requestReviewPrompt.trim() : "";
    const requestRequireAuthToUploadRaw =
      typeof body.requestRequireAuthToUpload === "boolean" ? body.requestRequireAuthToUpload : null;
    if (!shareOnly && !name) return NextResponse.json({ error: "Project name is required" }, { status: 400 });
    if (name.length > MAX_PROJECT_NAME_LENGTH) {
      return NextResponse.json(
        { error: `Project name must be ${MAX_PROJECT_NAME_LENGTH} characters or less` },
        { status: 400 },
      );
    }

    await connectMongo();
    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;

    if (!Types.ObjectId.isValid(projectIdParam)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }
    const project = await ProjectModel.findOne(
      liveProjectByIdMatch(new Types.ObjectId(projectIdParam), orgId, legacyUserId, allowLegacyByUserId),
    );
    if (!project) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    if (typeof body.shareEnabled === "boolean") {
      (project as unknown as { shareEnabled?: boolean }).shareEnabled = body.shareEnabled;
    }
    if (!shareOnly && project.orgId && name.toLowerCase() !== String(project.name ?? "").toLowerCase()) {
      if (await projectNameTaken(project.orgId as Types.ObjectId, name, project._id)) {
        return NextResponse.json({ error: "A project with that name already exists" }, { status: 409 });
      }
    }
    if (!shareOnly) {
      project.name = name;
      // Only fields the caller sent: a rename alone used to reset description to "" and
      // autoAddFiles to false.
      if (typeof body.description === "string") project.description = description;
      if (typeof body.autoAddFiles === "boolean") project.autoAddFiles = autoAddFiles;
    }
    const isRequest = Boolean((project as unknown as { isRequest?: unknown }).isRequest);
    if (isRequest && !shareOnly) {
      debugLog(1, "[api/projects/:id] PATCH request review settings", {
        projectId: projectIdParam,
        requestReviewEnabled,
        requestReviewPromptChars: requestReviewPrompt.length,
      });
      // `requestReviewPrompt` is optional; when omitted/empty, we run the server-managed default VC review prompts.
      (project as unknown as { requestReviewEnabled?: boolean }).requestReviewEnabled = requestReviewEnabled;
      (project as unknown as { requestReviewPrompt?: string }).requestReviewPrompt = requestReviewPrompt;
      if (typeof requestRequireAuthToUploadRaw === "boolean") {
        (project as unknown as { requestRequireAuthToUpload?: boolean }).requestRequireAuthToUpload =
          requestRequireAuthToUploadRaw;
      }
    }
    // A public page switched in the same save as a rename belongs in this row too; a switch on its
    // own is the share.updated row below.
    const changedFields = shareOnly
      ? []
      : (["name", "description", "autoAddFiles", "shareEnabled"] as const).filter((f) => project.isModified(f));
    await project.save();
    // The project share switch is a switch over the project's *links* now that a project can have
    // several (docs/prds/lnkdrp-project-links.md): `Project.shareEnabled` alone would leave
    // `/p/:shareId` resolving through a link row that still says enabled. Marks what it disables,
    // so switching back on does not resurrect a link the sender revoked on its own. Best-effort —
    // a project whose links cannot be reached still saves, and `syncProjectShareState` repairs the
    // flag on the next link edit.
    if (typeof body.shareEnabled === "boolean" && project.orgId) {
      try {
        await setAllProjectLinksEnabled({ orgId: project.orgId as Types.ObjectId, projectId: project._id, enabled: body.shareEnabled });
      } catch (err) {
        debugError(1, "[api/projects/:id] PATCH could not apply shareEnabled to project links", {
          projectId: projectIdParam,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (changedFields.length) {
      void recordActivity({
        orgId: actor.orgId,
        userId: actor.userId,
        actorKind: actor.kind,
        type: "project.updated",
        projectId: project._id,
        title: project.name ?? null,
        meta: { projectName: project.name ?? null, changed: changedFields },
        request,
      });
    }
    if (typeof body.shareEnabled === "boolean") {
      void recordActivity({
        orgId: actor.orgId,
        userId: actor.userId,
        actorKind: actor.kind,
        type: "share.updated",
        projectId: project._id,
        title: project.name ?? null,
        meta: { scope: "project", shareEnabled: body.shareEnabled },
        request,
      });
    }
    if (isRequest) {
      debugLog(1, "[api/projects/:id] PATCH request review saved", {
        projectId: projectIdParam,
        requestReviewEnabled: Boolean((project as unknown as { requestReviewEnabled?: unknown }).requestReviewEnabled),
        requestReviewPromptChars:
          typeof (project as unknown as { requestReviewPrompt?: unknown }).requestReviewPrompt === "string"
            ? String((project as unknown as { requestReviewPrompt?: string }).requestReviewPrompt ?? "").length
            : 0,
      });
    }

    const tokenRaw = (project as unknown as { requestUploadToken?: unknown }).requestUploadToken;
    const token = typeof tokenRaw === "string" && tokenRaw.trim() ? tokenRaw.trim() : "";
    const requestUploadPath = token ? `/request/${encodeURIComponent(token)}` : null;

    return applyTempUserHeaders(
      NextResponse.json({
        project: {
          id: String(project._id),
          shareId: (project as unknown as { shareId?: unknown }).shareId ?? null,
          shareEnabled: (project as unknown as { shareEnabled?: unknown }).shareEnabled !== false,
          name: project.name ?? "",
          slug: project.slug ?? "",
          description: project.description ?? "",
          docCount: (function () {
            const raw = (project as unknown as { docCount?: unknown }).docCount;
            return Number.isFinite(raw) ? Number(raw) : 0;
          })(),
          autoAddFiles: Boolean(project.autoAddFiles),
          isRequest,
          request: isRequest
            ? {
                uploadPath: requestUploadPath,
                requireAuthToUpload: Boolean(
                  (project as unknown as { requestRequireAuthToUpload?: unknown }).requestRequireAuthToUpload,
                ),
                reviewEnabled: Boolean((project as unknown as { requestReviewEnabled?: unknown }).requestReviewEnabled),
                reviewPrompt:
                  typeof (project as unknown as { requestReviewPrompt?: unknown }).requestReviewPrompt === "string"
                    ? String((project as unknown as { requestReviewPrompt?: string }).requestReviewPrompt ?? "")
                    : "",
                guideDocId: (function () {
                  const raw = (project as unknown as { requestReviewGuideDocId?: unknown }).requestReviewGuideDocId;
                  return raw ? String(raw) : null;
                })(),
              }
            : null,
        },
      }),
      actor,
    );
  } catch (err) {
    const authOrLimited = authOrRateLimitResponse(err);
    if (authOrLimited) return authOrLimited;
    const message = err instanceof Error ? err.message : "Unknown error";
    // Surface a clean message for duplicate-name per user.
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: number }).code === 11000
    ) {
      return NextResponse.json({ error: "A project with that name already exists" }, { status: 409 });
    }
    debugError(1, "[api/projects/:slug] PATCH failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
/**
 * Handle DELETE requests.
 */


export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ projectSlug: string }> },
) {
  try {
    const { projectSlug } = await ctx.params;
    const projectIdParam = decodeURIComponent(projectSlug).trim();

    debugLog(1, "[api/projects/:id] DELETE", { projectId: projectIdParam });
    const actor = await resolveActor(request);
    // Viewers can read a workspace but must not delete from it.
    const roleCheck = await requireOrgRole({ orgId: actor.orgId, userId: actor.userId, minRole: "member" });
    if (!roleCheck.ok) {
      return applyTempUserHeaders(NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status }), actor);
    }
    await connectMongo();

    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
    const docTenant = allowLegacyByUserId
      ? {
          $or: [
            { orgId },
            { userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
          ],
        }
      : { orgId };

    const body = (await request.json().catch(() => null)) as
      | null
      | undefined
      | {
          requestDocsMode?: unknown;
        };
    const requestDocsModeRaw = body && typeof body === "object" ? body.requestDocsMode : null;
    const requestDocsMode =
      typeof requestDocsModeRaw === "string" ? requestDocsModeRaw.trim().toLowerCase() : "";
    const requestDeleteMode =
      requestDocsMode === "delete_docs" || requestDocsMode === "orphan" || requestDocsMode === "copy_to_new_project"
        ? (requestDocsMode as "delete_docs" | "orphan" | "copy_to_new_project")
        : null;

    if (!Types.ObjectId.isValid(projectIdParam)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }
    const project = await ProjectModel.findOne(
      liveProjectByIdMatch(new Types.ObjectId(projectIdParam), orgId, legacyUserId, allowLegacyByUserId),
    );
    if (!project) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    const projectId = new Types.ObjectId(String(project._id));
    const tokenRaw = (project as unknown as { requestUploadToken?: unknown }).requestUploadToken;
    const token = typeof tokenRaw === "string" && tokenRaw.trim() ? tokenRaw.trim() : "";
    const isRequest = Boolean((project as unknown as { isRequest?: unknown }).isRequest) || Boolean(token);

    // For request repos, optionally allow controlling what happens to docs.
    if (isRequest && requestDeleteMode) {
      debugLog(1, "[api/projects/:id] DELETE request repo mode", { projectId: projectIdParam, requestDeleteMode });

      // All docs that were uploaded into this request repo (durable pointer) and any attached guide doc.
      // `$and`, not a spread: docTenant carries its own `$or` (legacy personal scope), and a second
      // `$or` key in the same object replaced it, dropping the workspace filter entirely.
      const requestDocs = await DocModel.find({
        $and: [
          docTenant,
          { isDeleted: { $ne: true } },
          {
            $or: [
              { receivedViaRequestProjectId: projectId },
              { guideForRequestProjectId: projectId },
              { primaryProjectId: projectId },
              { projectId },
              { projectIds: projectId },
            ],
          },
        ],
      })
        .select({ _id: 1, primaryProjectId: 1, projectId: 1 })
        .lean();

      if (requestDeleteMode === "copy_to_new_project") {
        const baseName = `${project.name ?? "Request"} (imported)`;
        const name = await ensureUniqueProjectName({
          orgId,
          legacyUserId: allowLegacyByUserId ? legacyUserId : undefined,
          base: baseName,
        });
        const slug = await ensureUniqueSlug({
          orgId,
          legacyUserId: allowLegacyByUserId ? legacyUserId : undefined,
          base: slugify(name),
        });
        const created = await ProjectModel.create({
          orgId,
          userId: legacyUserId,
          shareId: newProjectShareId(),
          name,
          slug,
          description: "",
          autoAddFiles: false,
          isRequest: false,
          requestUploadToken: null,
          requestViewToken: null,
          requestRequireAuthToUpload: false,
          requestReviewEnabled: false,
          requestReviewPrompt: "",
          requestReviewGuideDocId: null,
          isDeleted: false,
        });
        const newProjectId = new Types.ObjectId(String((created as unknown as { _id: Types.ObjectId })._id));

        // Best-effort: update each doc with updateOne so Project.docCount stays in sync.
        for (const d of requestDocs) {
          const docId = d && typeof d === "object" && "_id" in d ? (d as { _id?: unknown })._id : null;
          if (!docId) continue;

          const currentPrimary =
            (d as unknown as { primaryProjectId?: unknown }).primaryProjectId ??
            (d as unknown as { projectId?: unknown }).projectId;
          const primaryIsRequest = currentPrimary ? String(currentPrimary) === String(projectId) : false;
          const nextPrimary = primaryIsRequest || !currentPrimary ? newProjectId : currentPrimary;

          await DocModel.updateOne(
            { _id: docId, ...docTenant, isDeleted: { $ne: true } },
            {
              $set: {
                primaryProjectId: nextPrimary,
                projectId: nextPrimary,
                receivedViaRequestProjectId: null,
                guideForRequestProjectId: null,
              },
              $addToSet: { projectIds: newProjectId },
              $pull: { projectIds: projectId },
            },
          );
        }
      } else if (requestDeleteMode === "orphan") {
        for (const d of requestDocs) {
          const docId = d && typeof d === "object" && "_id" in d ? (d as { _id?: unknown })._id : null;
          if (!docId) continue;
          await DocModel.updateOne(
            { _id: docId, ...docTenant, isDeleted: { $ne: true } },
            {
              $set: {
                primaryProjectId: null,
                projectId: null,
                projectIds: [],
                receivedViaRequestProjectId: null,
                guideForRequestProjectId: null,
              },
            },
          );
        }
      } else if (requestDeleteMode === "delete_docs") {
        const now = new Date();
        for (const d of requestDocs) {
          const docId = d && typeof d === "object" && "_id" in d ? (d as { _id?: unknown })._id : null;
          if (!docId) continue;
          await DocModel.updateOne(
            { _id: docId, ...docTenant, isDeleted: { $ne: true } },
            {
              $set: {
                isDeleted: true,
                deletedDate: now,
                primaryProjectId: null,
                projectId: null,
                projectIds: [],
                receivedViaRequestProjectId: null,
                guideForRequestProjectId: null,
              },
            },
          );
        }
      }
    }

    // Remove project membership from docs (best-effort).
    await DocModel.updateMany(
      { $and: [docTenant, { $or: [{ projectId }, { primaryProjectId: projectId }] }] },
      { $set: { primaryProjectId: null, projectId: null } },
    );
    await DocModel.updateMany(
      { ...docTenant, projectIds: projectId },
      { $pull: { projectIds: projectId } },
    );
    // If a doc lost its primary but still has membership, set primary to first remaining projectId.
    try {
      await DocModel.collection.updateMany(
        {
          ...(docTenant as Record<string, unknown>),
          primaryProjectId: null,
          projectId: null,
          projectIds: { $exists: true, $ne: [] },
        },
        [{ $set: { primaryProjectId: { $arrayElemAt: ["$projectIds", 0] }, projectId: { $arrayElemAt: ["$projectIds", 0] } } }],
      );
    } catch {
      // ignore; best-effort
    }

    await ProjectModel.deleteOne({ _id: projectId, ...docTenant });

    // The project row is gone for good (this delete is not a soft one), so its tag assignments
    // have nothing left to point at (src/lib/tags/service.ts).
    void removeAllTagsFromTarget({ orgId: actor.orgId, targetKind: "project", targetId: projectId }).catch(() => {});
    void recordActivity({
      orgId: actor.orgId,
      userId: actor.userId,
      actorKind: actor.kind,
      type: "project.deleted",
      projectId,
      title: project.name ?? null,
      meta: { projectName: project.name ?? null, ...(isRequest ? { requestRepo: true } : {}) },
      request,
    });

    return applyTempUserHeaders(NextResponse.json({ ok: true }), actor);
  } catch (err) {
    const authOrLimited = authOrRateLimitResponse(err);
    if (authOrLimited) return authOrLimited;
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/projects/:slug] DELETE failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}



