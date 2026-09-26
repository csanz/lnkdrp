import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { workspaceListableDocFilter } from "@/lib/docs/visibility";
import { lockedHomeExclusionFor } from "@/lib/projects/lockScope";
import { TAG_DOCS_SORT } from "@/lib/tags/service";
import { debugLog } from "@/lib/debug";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { errorJson } from "@/lib/http/errorResponse";

export const runtime = "nodejs";
/**
 * Escape Regex (uses replace).
 */


function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * List docs that contain a specific AI tag (paged).
 *
 * Route params:
 * - tag (URL-encoded)
 *
 * Query params:
 * - limit, page
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ tag: string }> },
) {
  try {
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    const pageRaw = url.searchParams.get("page");
    const limit = Math.max(
      1,
      Math.min(50, Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 10),
    );
    const page = Math.max(1, Number.isFinite(Number(pageRaw)) ? Number(pageRaw) : 1);

    const { tag } = await ctx.params;
    const decodedTag = decodeURIComponent(tag).trim();
    if (!decodedTag) return NextResponse.json({ error: "Missing tag" }, { status: 400 });

    debugLog(2, "[api/tags/:tag/docs] GET", { limit, page, tag: "[redacted]" });
    const actor = await resolveActor(request);
    await connectMongo();

    // Scope to the active workspace (with legacy personal-doc fallback), mirroring `/api/docs`.
    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;

    // aiOutput.tags is an array of strings; match case-insensitively on the whole tag value.
    const rx = new RegExp(`^${escapeRegex(decodedTag)}$`, "i");
    const filter: Record<string, unknown> = {
      isDeleted: { $ne: true },
      ...workspaceListableDocFilter(),
      // Every row here carries the document's `shareId`, and `/s/:shareId` needs no workspace
      // identity, so an AI keyword shared by a private room's document would hand out the document
      // itself (docs/prds/lnkdrp-locked-projects.md, decision 13).
      ...(await lockedHomeExclusionFor(orgId, actor.userId, request)),
      "aiOutput.tags": rx,
      ...(allowLegacyByUserId
        ? {
            $or: [
              { orgId },
              { userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
            ],
          }
        : { orgId }),
    };

    const total = await DocModel.countDocuments(filter);
    const docs = await DocModel.find(filter)
      .sort(TAG_DOCS_SORT)
      .skip((page - 1) * limit)
      .limit(limit)
      .select({ _id: 1, title: 1, shareId: 1, updatedDate: 1, status: 1 })
      .lean();

    return applyTempUserHeaders(
      NextResponse.json({
        tag: decodedTag,
        total,
        page,
        limit,
        docs: docs.map((d) => ({
          id: String(d._id),
          shareId: d.shareId ?? null,
          title: d.title ?? "Untitled document",
          status: d.status ?? "draft",
          updatedDate: d.updatedDate ? new Date(d.updatedDate).toISOString() : null,
        })),
      }),
      actor,
    );
  } catch (err) {
    return errorJson(err, { status: 500, publicMessage: "Could not load docs for tag", context: "[api/tags/:tag/docs] GET failed" });
  }
}





