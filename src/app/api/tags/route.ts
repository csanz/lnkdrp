/**
 * API route for `/api/tags`.
 *
 * - `GET` — every tag in the workspace, alphabetical, with how many things carry each. This is what
 *   the sidebar section, the manage screen and the tag input's autocomplete all read.
 * - `POST { name }` — find or create. Creating is deliberately the same call as finding: typing
 *   "Fundraising" where "fundraising" exists must attach the existing tag, never make a twin, and a
 *   client that had to check first would race with itself.
 *
 * Any member can create and use tags; the destructive operations (rename, merge, delete) live on
 * `/api/tags/:tagId` and ask for more.
 */
import { NextResponse } from "next/server";

import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { forbidUnlessOrgRole } from "@/lib/orgs/requireOrgEditor";
import { findOrCreateTag, listTags, listTagsPage } from "@/lib/tags/service";
import { isUsableTagName } from "@/lib/tags/slug";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { errorJson } from "@/lib/http/errorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActor(request);
    if (actor.kind !== "user") {
      return applyTempUserHeaders(NextResponse.json({ error: "Unauthorized" }, { status: 401 }), actor);
    }
    try {
      /**
       * Paged only when asked. The sidebar, the tag input's autocomplete and the MCP all want the
       * whole list and have since this route existed; the manage screen is the one caller that
       * cannot, because a workspace that files properly ends up with hundreds. So `?limit=` opts
       * in, and everything else keeps the response it was written against.
       */
      const url = new URL(request.url);
      const wantsPage = url.searchParams.has("limit") || url.searchParams.has("page") || url.searchParams.has("q");
      if (wantsPage) {
        const asInt = (v: string | null) => {
          const n = Number(v);
          return Number.isFinite(n) ? Math.trunc(n) : null;
        };
        const paged = await listTagsPage({
          orgId: actor.orgId,
          q: url.searchParams.get("q"),
          page: asInt(url.searchParams.get("page")),
          limit: asInt(url.searchParams.get("limit")),
          withCounts: true,
          viewerUserId: actor.userId,
          request,
        });
        return applyTempUserHeaders(
          NextResponse.json({ ok: true, ...paged }, { headers: { "cache-control": "no-store" } }),
          actor,
        );
      }

      const tags = await listTags({ orgId: actor.orgId, withCounts: true, viewerUserId: actor.userId, request });
      return applyTempUserHeaders(
        NextResponse.json({ ok: true, tags, total: tags.length }, { headers: { "cache-control": "no-store" } }),
        actor,
      );
    } catch (err) {
      return applyTempUserHeaders(errorJson(err, { status: 500, publicMessage: "Could not load tags", context: "[api/tags] GET failed" }), actor);
    }
  });
}

export async function POST(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActor(request);
    if (actor.kind !== "user") {
      return applyTempUserHeaders(NextResponse.json({ error: "Unauthorized" }, { status: 401 }), actor);
    }
    const forbidden = await forbidUnlessOrgRole(actor);
    if (forbidden) return forbidden;

    try {
      const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
      const name = typeof body?.name === "string" ? body.name : "";
      if (!isUsableTagName(name)) {
        return applyTempUserHeaders(
          NextResponse.json({ error: "A tag needs at least one letter or number" }, { status: 400 }),
          actor,
        );
      }
      const { tag, created } = await findOrCreateTag({ orgId: actor.orgId, name, userId: actor.userId });
      return applyTempUserHeaders(NextResponse.json({ ok: true, tag, created }, { status: created ? 201 : 200 }), actor);
    } catch (err) {
      return applyTempUserHeaders(errorJson(err, { status: 500, publicMessage: "Could not create the tag", context: "[api/tags] POST failed" }), actor);
    }
  });
}
