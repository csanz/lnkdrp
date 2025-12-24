import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { ProjectModel } from "@/lib/models/Project";
import { DocModel } from "@/lib/models/Doc";
import { debugError, debugLog } from "@/lib/debug";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";

export const runtime = "nodejs";

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ projectSlug: string }> },
) {
  try {
    const { projectSlug } = await ctx.params;
    const slugParam = decodeURIComponent(projectSlug).trim();

    debugLog(1, "[api/projects/:slug] PATCH", { projectSlug: slugParam });
    const actor = await resolveActor(request);
    const body = (await request.json().catch(() => ({}))) as Partial<{
      name: string;
      description: string;
      autoAddFiles: boolean;
    }>;

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const autoAddFiles = typeof body.autoAddFiles === "boolean" ? body.autoAddFiles : false;
    if (!name) return NextResponse.json({ error: "Project name is required" }, { status: 400 });

    await connectMongo();
    const userId = new Types.ObjectId(actor.userId);

    // Prefer slug lookup; fallback to case-insensitive name match (backward-compat).
    const project =
      (await ProjectModel.findOne({ userId, slug: slugParam })) ??
      (await ProjectModel.findOne({
        userId,
        name: new RegExp(`^${escapeRegex(slugParam)}$`, "i"),
      }));
    if (!project) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    project.name = name;
    project.description = description;
    project.autoAddFiles = autoAddFiles;
    await project.save();

    return applyTempUserHeaders(
      NextResponse.json({
        project: {
          id: String(project._id),
          name: project.name ?? "",
          slug: project.slug ?? "",
          description: project.description ?? "",
          autoAddFiles: Boolean(project.autoAddFiles),
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

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ projectSlug: string }> },
) {
  try {
    const { projectSlug } = await ctx.params;
    const slugParam = decodeURIComponent(projectSlug).trim();

    debugLog(1, "[api/projects/:slug] DELETE", { projectSlug: slugParam });
    const actor = await resolveActor(request);
    await connectMongo();

    const userId = new Types.ObjectId(actor.userId);

    // Prefer slug lookup; fallback to case-insensitive name match (backward-compat).
    const project =
      (await ProjectModel.findOne({ userId, slug: slugParam })) ??
      (await ProjectModel.findOne({
        userId,
        name: new RegExp(`^${escapeRegex(slugParam)}$`, "i"),
      }));
    if (!project) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    const projectId = new Types.ObjectId(String(project._id));

    // Remove project membership from docs (best-effort).
    await DocModel.updateMany(
      { userId, projectId },
      { $set: { projectId: null } },
    );
    await DocModel.updateMany(
      { userId, projectIds: projectId },
      { $pull: { projectIds: projectId } },
    );
    // If a doc lost its primary but still has membership, set primary to first remaining projectId.
    try {
      await DocModel.collection.updateMany(
        { userId, projectId: null, projectIds: { $exists: true, $ne: [] } },
        [{ $set: { projectId: { $arrayElemAt: ["$projectIds", 0] } } }],
      );
    } catch {
      // ignore; best-effort
    }

    await ProjectModel.deleteOne({ _id: projectId, userId });

    return applyTempUserHeaders(NextResponse.json({ ok: true }), actor);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/projects/:slug] DELETE failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


