/**
 * API route for `/api/tags/:tagId`.
 *
 * The folder is `[tag]`, not `[tagId]`: `/api/tags/[tag]/docs` predates this and lists documents by
 * AI tag name, and Next refuses two different slug names on one path. The param here is an id.
 *
 * - `PATCH { name?, color?, mergeIntoTagId? }` — rename, recolour, or merge this tag into another.
 * - `DELETE` — remove the tag and every assignment of it. The documents and projects stay.
 *
 * Owner or admin only. Renaming and merging change what everyone in the workspace sees, and
 * deleting removes other people's work; using a tag (create, attach, detach) stays open to members.
 *
 * Renaming onto a name that already exists is refused rather than silently merged: the service
 * says so, and the client offers merge as the explicit next step.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { forbidUnlessOrgRole } from "@/lib/orgs/requireOrgEditor";
import { deleteTag, mergeTags, updateTag } from "@/lib/tags/service";
import { asTagColorKey, TAG_COLOR_KEYS } from "@/lib/tags/palette";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, ctx: { params: Promise<{ tag: string }> }) {
  return withMongoRequestLogging(request, async () => {
    const { tag: tagId } = await ctx.params;
    const actor = await resolveActor(request);
    if (actor.kind !== "user") {
      return applyTempUserHeaders(NextResponse.json({ error: "Unauthorized" }, { status: 401 }), actor);
    }
    const forbidden = await forbidUnlessOrgRole(actor, "admin");
    if (forbidden) return forbidden;
    if (!Types.ObjectId.isValid(tagId)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    try {
      const body = (await request.json().catch(() => null)) as
        | { name?: unknown; color?: unknown; mergeIntoTagId?: unknown }
        | null;

      if (typeof body?.mergeIntoTagId === "string" && body.mergeIntoTagId.trim()) {
        const intoTagId = body.mergeIntoTagId.trim();
        if (!Types.ObjectId.isValid(intoTagId)) {
          return applyTempUserHeaders(NextResponse.json({ error: "Unknown tag to merge into" }, { status: 400 }), actor);
        }
        const result = await mergeTags({ orgId: actor.orgId, fromTagId: tagId, intoTagId });
        return applyTempUserHeaders(NextResponse.json({ ok: true, merged: result }), actor);
      }

      const color =
        typeof body?.color === "string" && (TAG_COLOR_KEYS as readonly string[]).includes(body.color)
          ? asTagColorKey(body.color)
          : undefined;
      const tag = await updateTag({
        orgId: actor.orgId,
        tagId,
        name: typeof body?.name === "string" ? body.name : undefined,
        color,
      });
      return applyTempUserHeaders(NextResponse.json({ ok: true, tag }), actor);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not update the tag";
      const status = /not found/i.test(message) ? 404 : 400;
      return applyTempUserHeaders(NextResponse.json({ error: message }, { status }), actor);
    }
  });
}

export async function DELETE(request: Request, ctx: { params: Promise<{ tag: string }> }) {
  return withMongoRequestLogging(request, async () => {
    const { tag: tagId } = await ctx.params;
    const actor = await resolveActor(request);
    if (actor.kind !== "user") {
      return applyTempUserHeaders(NextResponse.json({ error: "Unauthorized" }, { status: 401 }), actor);
    }
    const forbidden = await forbidUnlessOrgRole(actor, "admin");
    if (forbidden) return forbidden;
    if (!Types.ObjectId.isValid(tagId)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    try {
      await deleteTag({ orgId: actor.orgId, tagId });
      return applyTempUserHeaders(NextResponse.json({ ok: true }), actor);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not delete the tag";
      return applyTempUserHeaders(NextResponse.json({ error: message }, { status: 400 }), actor);
    }
  });
}
