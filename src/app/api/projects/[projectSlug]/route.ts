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

export const runtime = "nodejs";

const MAX_PROJECT_NAME_LENGTH = 80;
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
    const body = (await request.json().catch(() => ({}))) as Partial<{
      name: string;
      description: string;
      autoAddFiles: boolean;
      requestReviewEnabled: boolean;
      requestReviewPrompt: string;
      requestRequireAuthToUpload: boolean;
    }>;

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const autoAddFiles = typeof body.autoAddFiles === "boolean" ? body.autoAddFiles : false;
    const requestReviewEnabled =
      typeof body.requestReviewEnabled === "boolean" ? body.requestReviewEnabled : false;
    const requestReviewPrompt =
      typeof body.requestReviewPrompt === "string" ? body.requestReviewPrompt.trim() : "";
    const requestRequireAuthToUploadRaw =
      typeof body.requestRequireAuthToUpload === "boolean" ? body.requestRequireAuthToUpload : null;
    if (!name) return NextResponse.json({ error: "Project name is required" }, { status: 400 });
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
      allowLegacyByUserId
        ? {
            $or: [
              { _id: new Types.ObjectId(projectIdParam), orgId },
              {
                _id: new Types.ObjectId(projectIdParam),
                userId: legacyUserId,
                $or: [{ orgId: { $exists: false } }, { orgId: null }],
              },
            ],
          }
        : { _id: new Types.ObjectId(projectIdParam), orgId },
    );
    if (!project) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    project.name = name;
    project.description = description;
    project.autoAddFiles = autoAddFiles;
    const isRequest = Boolean((project as unknown as { isRequest?: unknown }).isRequest);
    if (isRequest) {
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
    await project.save();
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

    if (!Types.ObjectId.isValid(projectIdParam)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }
    const project = await ProjectModel.findOne(
      allowLegacyByUserId
        ? {
            $or: [
              { _id: new Types.ObjectId(projectIdParam), orgId },
              {
                _id: new Types.ObjectId(projectIdParam),
                userId: legacyUserId,
                $or: [{ orgId: { $exists: false } }, { orgId: null }],
              },
            ],
          }
        : { _id: new Types.ObjectId(projectIdParam), orgId },
    );
    if (!project) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    const projectId = new Types.ObjectId(String(project._id));

    // Remove project membership from docs (best-effort).
    await DocModel.updateMany(
      { ...docTenant, projectId },
      { $set: { projectId: null } },
    );
    await DocModel.updateMany(
      { ...docTenant, projectIds: projectId },
      { $pull: { projectIds: projectId } },
    );
    // If a doc lost its primary but still has membership, set primary to first remaining projectId.
    try {
      await DocModel.collection.updateMany(
        { ...(docTenant as Record<string, unknown>), projectId: null, projectIds: { $exists: true, $ne: [] } },
        [{ $set: { projectId: { $arrayElemAt: ["$projectIds", 0] } } }],
      );
    } catch {
      // ignore; best-effort
    }

    await ProjectModel.deleteOne({ _id: projectId, ...docTenant });

    return applyTempUserHeaders(NextResponse.json({ ok: true }), actor);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/projects/:slug] DELETE failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}



