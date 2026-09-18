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
import { findOrCreateTag, listTags } from "@/lib/tags/service";
import { isUsableTagName } from "@/lib/tags/slug";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActor(request);
    if (actor.kind !== "user") {
      return applyTempUserHeaders(NextResponse.json({ error: "Unauthorized" }, { status: 401 }), actor);
    }
    try {
      const tags = await listTags({ orgId: actor.orgId, withCounts: true });
      return applyTempUserHeaders(
        NextResponse.json({ ok: true, tags }, { headers: { "cache-control": "no-store" } }),
        actor,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not load tags";
      return applyTempUserHeaders(NextResponse.json({ error: message }, { status: 400 }), actor);
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
      const message = err instanceof Error ? err.message : "Could not create the tag";
      return applyTempUserHeaders(NextResponse.json({ error: message }, { status: 400 }), actor);
    }
  });
}
