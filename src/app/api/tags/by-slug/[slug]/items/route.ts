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
import { workspaceListableDocFilter } from "@/lib/docs/visibility";
import { lockedHomeExclusionFor, projectGrantIds, projectVisibilityClause } from "@/lib/projects/lockScope";
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

    /**
     * Neither list is capped, deliberately.
     *
     * Both queries used to end in `.limit(200)` and the response said nothing about it. Everywhere
     * else a tag's size comes from `countLiveAssignments`, which counts every live assignment, so a
     * tag on 250 documents read "250 items" in the sidebar, on `/tags` and in the delete
     * confirmation, and "200 items" on `/tag/:slug`, the one page that lists what carries a tag
     * and so the one that can only count the rows it was handed. The 50 oldest-updated documents were
     * reachable from nowhere, and nothing on the page or in the payload admitted a cap had been
     * applied. The MCP's `list_docs { tag }` filter resolves through this route as well, so an
     * agent asking for a tag's documents was handed a truncated list as the whole list; that is
     * the same mistake `list_docs` already unlearned once, when it passed a tag's ids to
     * `GET /api/docs` and got fifty back reported as the total.
     *
     * Bounding it would mean returning the real totals and a "showing the N most recently updated"
     * line to go with them, which is the shape for the day a workspace makes this list hurt.
     * Until then the read is bounded by what it was always bounded by: the assignment rows, which
     * `targetsForTag` here and the sidebar's own count both already load uncapped.
     */
    /**
     * Both lists carry the locked-room rule (docs/prds/lnkdrp-locked-projects.md, decision 16).
     *
     * A tag page is the one place both kinds meet, so it is the one place a single missing clause
     * leaks both: the projects list names a room outright and the documents list carries titles from
     * inside one. The assignment rows above are read by `orgId` alone, deliberately, because they are
     * ids and the two reads below are where ids become names.
     */
    const [lockedExclusion, grantIds] = await Promise.all([
      lockedHomeExclusionFor(orgId, actor.userId, request),
      projectGrantIds(orgId, actor.userId, request),
    ]);

    const [docs, projects] = await Promise.all([
      docIds.length
        ? DocModel.find({ _id: { $in: docIds.map((id) => new Types.ObjectId(id)) }, orgId, isDeleted: { $ne: true }, ...workspaceListableDocFilter(), ...lockedExclusion })
            .select({ title: 1, updatedDate: 1, createdDate: 1, currentVersion: 1, isArchived: 1 })
            .sort({ updatedDate: -1 })
            .lean()
        : Promise.resolve([]),
      projectIds.length
        ? ProjectModel.find({
            _id: { $in: projectIds.map((id) => new Types.ObjectId(id)) },
            orgId,
            isDeleted: { $ne: true },
            $and: [projectVisibilityClause(grantIds)],
          })
            .select({ name: 1, slug: 1, description: 1, docCount: 1, updatedDate: 1 })
            .sort({ updatedDate: -1 })
            .lean()
        : Promise.resolve([]),
    ]);

    return applyTempUserHeaders(
      NextResponse.json(
        {
          ok: true,
          // The tag carries its own count now, so a caller never has to infer the size of a tag
          // from the length of a list it cannot tell is complete. It is the same rule
          // `countLiveAssignments` applies (live targets, archived documents included, one row per
          // target by the unique assignment index), so the two ways of asking agree.
          tag: toTagDTO(tag as never, docs.length + projects.length),
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
