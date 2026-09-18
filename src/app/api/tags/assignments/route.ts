/**
 * API route for `/api/tags/assignments` — putting a tag on a document or a project, and taking it
 * off again.
 *
 * - `GET ?targetKind=doc|project&targetId=` — the tags on one thing, for its chip row.
 * - `POST { targetKind, targetId, tagId | name }` — attach. Accepting a *name* is what lets the tag
 *   input do "type it and press Enter" in one call: find-or-create, then attach, with no round trip
 *   in between for the client to race against.
 * - `DELETE { targetKind, targetId, tagId }` — detach. Detaching something already gone is fine.
 *
 * The target is checked against the caller's workspace before anything is written: a tag id and a
 * document id both look like any other id, and neither is proof of access on its own.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { forbidUnlessOrgRole } from "@/lib/orgs/requireOrgEditor";
import { DocModel } from "@/lib/models/Doc";
import { ProjectModel } from "@/lib/models/Project";
import { TAG_TARGET_KINDS, type TagTargetKind } from "@/lib/models/TagAssignment";
import { attachTag, detachTag, findOrCreateTag, tagsForTarget } from "@/lib/tags/service";
import { isUsableTagName } from "@/lib/tags/slug";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function asTargetKind(value: unknown): TagTargetKind | null {
  return typeof value === "string" && (TAG_TARGET_KINDS as readonly string[]).includes(value)
    ? (value as TagTargetKind)
    : null;
}

/** The target exists, is live, and belongs to the caller's workspace — or this returns false. */
async function targetIsInWorkspace(params: {
  orgId: string;
  targetKind: TagTargetKind;
  targetId: string;
}): Promise<boolean> {
  if (!Types.ObjectId.isValid(params.targetId)) return false;
  await connectMongo();
  const orgId = new Types.ObjectId(params.orgId);
  const _id = new Types.ObjectId(params.targetId);
  const found =
    params.targetKind === "doc"
      ? await DocModel.findOne({ _id, orgId, isDeleted: { $ne: true } }).select({ _id: 1 }).lean()
      : await ProjectModel.findOne({ _id, orgId, isDeleted: { $ne: true } }).select({ _id: 1 }).lean();
  return Boolean(found);
}

export async function GET(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActor(request);
    if (actor.kind !== "user") {
      return applyTempUserHeaders(NextResponse.json({ error: "Unauthorized" }, { status: 401 }), actor);
    }
    const url = new URL(request.url);
    const targetKind = asTargetKind(url.searchParams.get("targetKind"));
    const targetId = (url.searchParams.get("targetId") ?? "").trim();
    if (!targetKind || !targetId) {
      return applyTempUserHeaders(NextResponse.json({ error: "targetKind and targetId are required" }, { status: 400 }), actor);
    }
    if (!(await targetIsInWorkspace({ orgId: actor.orgId, targetKind, targetId }))) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    const tags = await tagsForTarget({ orgId: actor.orgId, targetKind, targetId });
    return applyTempUserHeaders(
      NextResponse.json({ ok: true, tags }, { headers: { "cache-control": "no-store" } }),
      actor,
    );
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
      const body = (await request.json().catch(() => null)) as
        | { targetKind?: unknown; targetId?: unknown; tagId?: unknown; name?: unknown }
        | null;
      const targetKind = asTargetKind(body?.targetKind);
      const targetId = typeof body?.targetId === "string" ? body.targetId.trim() : "";
      if (!targetKind || !targetId) {
        return applyTempUserHeaders(NextResponse.json({ error: "targetKind and targetId are required" }, { status: 400 }), actor);
      }
      if (!(await targetIsInWorkspace({ orgId: actor.orgId, targetKind, targetId }))) {
        return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
      }

      let tagId = typeof body?.tagId === "string" ? body.tagId.trim() : "";
      let created = false;
      if (!tagId) {
        const name = typeof body?.name === "string" ? body.name : "";
        if (!isUsableTagName(name)) {
          return applyTempUserHeaders(
            NextResponse.json({ error: "A tag needs at least one letter or number" }, { status: 400 }),
            actor,
          );
        }
        const result = await findOrCreateTag({ orgId: actor.orgId, name, userId: actor.userId });
        tagId = result.tag.id;
        created = result.created;
      }
      if (!Types.ObjectId.isValid(tagId)) {
        return applyTempUserHeaders(NextResponse.json({ error: "Unknown tag" }, { status: 400 }), actor);
      }

      await attachTag({ orgId: actor.orgId, tagId, targetKind, targetId, userId: actor.userId });
      const tags = await tagsForTarget({ orgId: actor.orgId, targetKind, targetId });
      return applyTempUserHeaders(NextResponse.json({ ok: true, tags, created }), actor);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not add the tag";
      const status = /not found/i.test(message) ? 404 : 400;
      return applyTempUserHeaders(NextResponse.json({ error: message }, { status }), actor);
    }
  });
}

export async function DELETE(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActor(request);
    if (actor.kind !== "user") {
      return applyTempUserHeaders(NextResponse.json({ error: "Unauthorized" }, { status: 401 }), actor);
    }
    const forbidden = await forbidUnlessOrgRole(actor);
    if (forbidden) return forbidden;

    try {
      const url = new URL(request.url);
      const body = (await request.json().catch(() => null)) as
        | { targetKind?: unknown; targetId?: unknown; tagId?: unknown }
        | null;
      const targetKind = asTargetKind(body?.targetKind ?? url.searchParams.get("targetKind"));
      const targetId = String(body?.targetId ?? url.searchParams.get("targetId") ?? "").trim();
      const tagId = String(body?.tagId ?? url.searchParams.get("tagId") ?? "").trim();
      if (!targetKind || !targetId || !Types.ObjectId.isValid(tagId)) {
        return applyTempUserHeaders(
          NextResponse.json({ error: "targetKind, targetId and tagId are required" }, { status: 400 }),
          actor,
        );
      }
      if (!(await targetIsInWorkspace({ orgId: actor.orgId, targetKind, targetId }))) {
        return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
      }

      await detachTag({ orgId: actor.orgId, tagId, targetKind, targetId });
      const tags = await tagsForTarget({ orgId: actor.orgId, targetKind, targetId });
      return applyTempUserHeaders(NextResponse.json({ ok: true, tags }), actor);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not remove the tag";
      return applyTempUserHeaders(NextResponse.json({ error: message }, { status: 400 }), actor);
    }
  });
}
