import { NextResponse } from "next/server";
import { Types } from "mongoose";
import crypto from "node:crypto";
import { connectMongo } from "@/lib/mongodb";
import { ProjectModel } from "@/lib/models/Project";
import { DocModel } from "@/lib/models/Doc";
import { UploadModel } from "@/lib/models/Upload";
import { debugError, debugLog } from "@/lib/debug";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";

export const runtime = "nodejs";

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ projectSlug: string }> },
) {
  try {
    const { projectSlug } = await ctx.params;
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

    debugLog(2, "[api/projects/:slug/docs] GET", {
      projectSlug,
      limit,
      page,
      q: q ? "[redacted]" : "",
    });

    const actor = await resolveActor(request);
    await connectMongo();

    const userId = new Types.ObjectId(actor.userId);
    const slugParam = decodeURIComponent(projectSlug).trim();
    let project = await ProjectModel.findOne({ userId, slug: slugParam })
      .select({ _id: 1, name: 1, slug: 1, description: 1, autoAddFiles: 1 })
      .lean();

    // Backward-compat: some existing projects may not have a persisted slug yet,
    // or the slug in the client may not match what's stored. Fall back to name match.
    if (!project) {
      project = await ProjectModel.findOne({
        userId,
        name: new RegExp(`^${escapeRegex(slugParam)}$`, "i"),
      })
        .select({ _id: 1, name: 1, slug: 1, description: 1, autoAddFiles: 1 })
        .lean();

      // Best-effort: persist a stable slug so future requests resolve directly.
      if (project) {
        const desired = slugify(project.name ?? slugParam) || slugify(slugParam) || "project";
        try {
          await ProjectModel.updateOne(
            { _id: project._id, userId, $or: [{ slug: { $exists: false } }, { slug: null }, { slug: "" }] },
            { $set: { slug: desired } },
          );
          project.slug = desired;
        } catch {
          // ignore; slug collision will just keep fallback working
        }
      }
    }

    if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const filter: Record<string, unknown> = {
      userId,
      isDeleted: { $ne: true },
      isArchived: { $ne: true },
      $and: [
        // Backward-compat: old docs only have `projectId`; new docs use `projectIds[]`.
        { $or: [{ projectId: project._id }, { projectIds: project._id }] },
      ],
    };
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      (filter.$and as Array<Record<string, unknown>>).push({ $or: [{ title: rx }, { shareId: rx }] });
    }

    const total = await DocModel.countDocuments(filter);
    const docs = await DocModel.find(filter)
      .sort({ updatedDate: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // Add current upload versions (best-effort), same as /api/docs.
    const currentUploadIds = docs
      .map((d) => d.currentUploadId ?? (d as unknown as { uploadId?: unknown }).uploadId)
      .filter(Boolean);
    const uploadsById = new Map<string, number>();
    if (currentUploadIds.length) {
      const uploads = await UploadModel.find({ _id: { $in: currentUploadIds } })
        .select({ _id: 1, version: 1 })
        .lean();
      for (const u of uploads) {
        const v = (u as { version?: unknown }).version;
        if (Number.isFinite(v)) uploadsById.set(String(u._id), Number(v));
      }
    }

    const payload = {
      project: {
        id: String(project._id),
        name: project.name ?? "",
        slug: project.slug ?? "",
        description: project.description ?? "",
        autoAddFiles: Boolean((project as unknown as { autoAddFiles?: unknown }).autoAddFiles),
      },
      total,
      page,
      limit,
      docs: docs.map((d) => {
        const currentUploadId =
          d.currentUploadId ?? (d as unknown as { uploadId?: unknown }).uploadId ?? null;
        const previewImageUrlRaw =
          d.previewImageUrl ?? (d as unknown as { firstPagePngUrl?: unknown }).firstPagePngUrl ?? null;
        const previewImageUrl = typeof previewImageUrlRaw === "string" ? previewImageUrlRaw : null;
        const ai = (d as unknown as { aiOutput?: unknown }).aiOutput;
        const summary =
          ai && typeof ai === "object"
            ? ((ai as { summary?: unknown }).summary ?? null)
            : null;
        const projectIdsRaw = (d as unknown as { projectIds?: unknown }).projectIds;
        const projectIds = Array.isArray(projectIdsRaw)
          ? projectIdsRaw.map((x) => String(x))
          : [];
        const legacyProjectId = (d as unknown as { projectId?: unknown }).projectId;
        const allProjectIds = [
          ...(legacyProjectId ? [String(legacyProjectId)] : []),
          ...projectIds,
        ].filter(Boolean);
        const uniqueProjectIds = Array.from(new Set(allProjectIds));
        return {
          id: String(d._id),
          shareId: d.shareId ?? null,
          title: d.title ?? "Untitled document",
          summary: typeof summary === "string" ? summary : null,
          status: d.status ?? "draft",
          projectIds: uniqueProjectIds,
          previewImageUrl,
          currentUploadId: currentUploadId ? String(currentUploadId) : null,
          version: currentUploadId ? uploadsById.get(String(currentUploadId)) ?? null : null,
          updatedDate: d.updatedDate ? new Date(d.updatedDate).toISOString() : null,
          createdDate: d.createdDate ? new Date(d.createdDate).toISOString() : null,
        };
      }),
    };

    // ETag/304: lets clients avoid re-downloading JSON unless the payload truly changed.
    const hash = crypto.createHash("sha1").update(JSON.stringify(payload)).digest("base64url");
    const etag = `W/"${hash}"`;
    const inm = request.headers.get("if-none-match") ?? "";
    const cacheControl = "private, max-age=0, must-revalidate";

    if (inm === etag) {
      const res = new NextResponse(null, { status: 304 });
      res.headers.set("etag", etag);
      res.headers.set("cache-control", cacheControl);
      return applyTempUserHeaders(res, actor);
    }

    const res = NextResponse.json(payload);
    res.headers.set("etag", etag);
    res.headers.set("cache-control", cacheControl);
    return applyTempUserHeaders(res, actor);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/projects/:slug/docs] GET failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}




