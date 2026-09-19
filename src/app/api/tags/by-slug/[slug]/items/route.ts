/**
 * API route for `/api/tags/by-slug/:slug/items` — everything carrying one workspace tag.
 *
 * Under `by-slug/` rather than beside `/api/tags/:tag` because that folder is already the home of
 * the *AI* tags (`/api/tags/:tag/docs` lists documents by extracted keyword), and two unrelated
 * things called "tag" sharing a path is how a route ends up answering the wrong question.
 *
 * Documents and projects come back together, because the point of a tag page is that "fundraising"
 * is one idea even when it is spread across both.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { DocModel } from "@/lib/models/Doc";
import { ProjectModel } from "@/lib/models/Project";
import { TagModel } from "@/lib/models/Tag";
import { toTagDTO, targetsForTag } from "@/lib/tags/service";
import { tagSlug } from "@/lib/tags/slug";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActor(request);
    if (actor.kind !== "user") {
      return applyTempUserHeaders(NextResponse.json({ error: "Unauthorized" }, { status: 401 }), actor);
    }

    const { slug: raw } = await ctx.params;
    // Folded, not trusted: `/tag/Fundraising` and `/tag/fundraising` are the same page.
    const slug = tagSlug(decodeURIComponent(raw ?? ""));
    if (!slug) return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);

    await connectMongo();
    const orgId = new Types.ObjectId(actor.orgId);
    const tag = await TagModel.findOne({ orgId, slug }).lean();
    if (!tag) return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);

    const { docIds, projectIds } = await targetsForTag({ orgId, tagId: String((tag as { _id: Types.ObjectId })._id) });

    const [docs, projects] = await Promise.all([
      docIds.length
        ? DocModel.find({ _id: { $in: docIds.map((id) => new Types.ObjectId(id)) }, orgId, isDeleted: { $ne: true } })
            .select({ title: 1, updatedDate: 1, createdDate: 1, currentVersion: 1, isArchived: 1 })
            .sort({ updatedDate: -1 })
            .limit(200)
            .lean()
        : Promise.resolve([]),
      projectIds.length
        ? ProjectModel.find({ _id: { $in: projectIds.map((id) => new Types.ObjectId(id)) }, orgId, isDeleted: { $ne: true } })
            .select({ name: 1, slug: 1, description: 1, docCount: 1, updatedDate: 1 })
            .sort({ updatedDate: -1 })
            .limit(200)
            .lean()
        : Promise.resolve([]),
    ]);

    return applyTempUserHeaders(
      NextResponse.json(
        {
          ok: true,
          tag: toTagDTO(tag as never),
          docs: (docs as Array<Record<string, unknown>>).map((d) => ({
            id: String(d._id),
            title: typeof d.title === "string" ? d.title : "",
            version: typeof d.currentVersion === "number" ? d.currentVersion : null,
            isArchived: Boolean(d.isArchived),
            updatedDate: d.updatedDate instanceof Date ? d.updatedDate.toISOString() : null,
          })),
          projects: (projects as Array<Record<string, unknown>>).map((p) => ({
            id: String(p._id),
            name: typeof p.name === "string" ? p.name : "",
            slug: typeof p.slug === "string" ? p.slug : "",
            description: typeof p.description === "string" ? p.description : "",
            docCount: typeof p.docCount === "number" ? p.docCount : null,
          })),
        },
        { headers: { "cache-control": "no-store" } },
      ),
      actor,
    );
  });
}
