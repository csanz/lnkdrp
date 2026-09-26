/**
 * API route for `/api/tags/assignments` — putting a tag on a document, a project or a contact, and
 * taking it off again.
 *
 * - `GET ?targetKind=doc|project|contact&targetId=` — the tags on one thing, for its chip row.
 * - `POST { targetKind, targetId, tagId | name }` — attach. Accepting a *name* is what lets the tag
 *   input do "type it and press Enter" in one call: find-or-create, then attach, with no round trip
 *   in between for the client to race against.
 * - `DELETE { targetKind, targetId, tagId }` — detach. Detaching something already gone is fine.
 *
 * The target is checked against the caller's workspace before anything is written: a tag id and a
 * document id both look like any other id, and neither is proof of access on its own.
 *
 * A contact target writes the person into the activity row's `meta` the way the plan allows: the
 * feed is read on Free too, and a contact who never introduced themselves is "Someone" there, as
 * everywhere else (docs/prds/lnkdrp-contacts.md, decision 4).
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { forbidUnlessOrgRole } from "@/lib/orgs/requireOrgEditor";
import { DocModel } from "@/lib/models/Doc";
import { ProjectModel } from "@/lib/models/Project";
import { ContactModel } from "@/lib/models/Contact";
import { getWorkspacePlan } from "@/lib/billing/planLimits";
import { TAG_TARGET_KINDS, type TagTargetKind } from "@/lib/models/TagAssignment";
import { attachTag, detachTag, findOrCreateTag, tagsForTarget } from "@/lib/tags/service";
import { isUsableTagName } from "@/lib/tags/slug";
import { recordActivity } from "@/lib/activity/log";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function asTargetKind(value: unknown): TagTargetKind | null {
  return typeof value === "string" && (TAG_TARGET_KINDS as readonly string[]).includes(value)
    ? (value as TagTargetKind)
    : null;
}

/**
 * What the target check found: whether the thing is reachable at all, and, for a document, the
 * project it lives in.
 *
 * The home project is returned from here rather than looked up again because this check already
 * reads the document, and the activity row below needs the room: a project's feed is filtered on
 * the row's `projectId` (docs/prds/lnkdrp-project-home.md, decision 2), so filing a data room's
 * document was invisible in that data room. `homeProjectId` is null for the kinds that have no
 * home of their own, and for a document that lives in no project.
 */
type TargetCheck = { ok: boolean; homeProjectId: string | null };

const NOT_IN_WORKSPACE: TargetCheck = { ok: false, homeProjectId: null };

/** The target exists, is live, and belongs to the caller's workspace — or this returns `ok: false`. */
async function targetIsInWorkspace(params: {
  orgId: string;
  targetKind: TagTargetKind;
  targetId: string;
}): Promise<TargetCheck> {
  if (!Types.ObjectId.isValid(params.targetId)) return NOT_IN_WORKSPACE;
  await connectMongo();
  const orgId = new Types.ObjectId(params.orgId);
  const _id = new Types.ObjectId(params.targetId);
  const live = { _id, orgId, isDeleted: { $ne: true } };
  // A switch, not a ternary: a kind this does not know must fail closed rather than be looked up
  // in whichever model the "else" branch happened to name.
  switch (params.targetKind) {
    case "doc": {
      const doc = (await DocModel.findOne(live).select({ _id: 1, primaryProjectId: 1 }).lean()) as
        | { primaryProjectId?: unknown }
        | null;
      if (!doc) return NOT_IN_WORKSPACE;
      return { ok: true, homeProjectId: doc.primaryProjectId ? String(doc.primaryProjectId) : null };
    }
    case "project":
      return (await ProjectModel.findOne(live).select({ _id: 1 }).lean()) ? { ok: true, homeProjectId: null } : NOT_IN_WORKSPACE;
    case "contact":
      return (await ContactModel.findOne(live).select({ _id: 1 }).lean()) ? { ok: true, homeProjectId: null } : NOT_IN_WORKSPACE;
    default:
      return NOT_IN_WORKSPACE;
  }
}

/**
 * What the activity row may say about a tagged contact.
 *
 * The row is rendered for every member on every plan, so it carries the person only when the
 * product would show them anyway: on Pro, or when they introduced themselves (an introduction is
 * shown on Free too, because it was volunteered to this workspace). Otherwise the row keeps the
 * id and the domain and reads "a contact". Names and addresses here are reader-supplied text;
 * the MCP wraps `contactName` and `contactEmail` as untrusted on the way to an agent.
 */
async function contactActivityMeta(params: { orgId: string; contactId: string }): Promise<Record<string, unknown>> {
  const contact = (await ContactModel.findOne({ _id: new Types.ObjectId(params.contactId), orgId: new Types.ObjectId(params.orgId) })
    .select({ name: 1, email: 1, domain: 1, sources: 1 })
    .lean()) as { name?: string | null; email?: string | null; domain?: string | null; sources?: Array<{ kind?: string }> } | null;
  if (!contact) return { contactId: params.contactId };
  const introduced = Array.isArray(contact.sources) && contact.sources.some((s) => s?.kind === "introduced");
  const identity = introduced || (await getWorkspacePlan(params.orgId)) === "pro";
  return {
    contactId: params.contactId,
    ...(contact.domain ? { contactDomain: contact.domain } : {}),
    ...(identity && contact.name ? { contactName: contact.name } : {}),
    ...(identity && contact.email ? { contactEmail: contact.email } : {}),
  };
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
    if (!(await targetIsInWorkspace({ orgId: actor.orgId, targetKind, targetId })).ok) {
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
      const target = await targetIsInWorkspace({ orgId: actor.orgId, targetKind, targetId });
      if (!target.ok) {
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

      const before = await tagsForTarget({ orgId: actor.orgId, targetKind, targetId });
      await attachTag({ orgId: actor.orgId, tagId, targetKind, targetId, userId: actor.userId });
      const tags = await tagsForTarget({ orgId: actor.orgId, targetKind, targetId });

      // Only when it actually changed: re-tagging something is the same fact, not a second event,
      // and an agent that tags defensively should not fill the feed with rows saying nothing new.
      const added = tags.find((t) => t.id === tagId && !before.some((b) => b.id === t.id));
      if (added) {
        const who = targetKind === "contact" ? await contactActivityMeta({ orgId: actor.orgId, contactId: targetId }) : {};
        void recordActivity({
          orgId: actor.orgId,
          userId: actor.userId,
          actorKind: actor.kind,
          type: "tag.applied",
          docId: targetKind === "doc" ? targetId : undefined,
          // A tagged project is itself the row's project; a tagged document lends the row the room
          // it lives in, so the room's feed shows its own filing (decision 2 of the project-home
          // PRD). Everything else has no project and the row keeps `projectId` null.
          projectId: targetKind === "project" ? targetId : (target.homeProjectId ?? undefined),
          // The name is copied in, so a tag later renamed, merged or deleted still reads correctly
          // in the history of what was done that day.
          meta: { tagId, tagName: added.name, tagSlug: added.slug, targetKind, created, ...who },
          request,
        });
      }

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
      const target = await targetIsInWorkspace({ orgId: actor.orgId, targetKind, targetId });
      if (!target.ok) {
        return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
      }

      const before = await tagsForTarget({ orgId: actor.orgId, targetKind, targetId });
      await detachTag({ orgId: actor.orgId, tagId, targetKind, targetId });
      const tags = await tagsForTarget({ orgId: actor.orgId, targetKind, targetId });

      const removed = before.find((t) => t.id === tagId && !tags.some((n) => n.id === t.id));
      if (removed) {
        const who = targetKind === "contact" ? await contactActivityMeta({ orgId: actor.orgId, contactId: targetId }) : {};
        void recordActivity({
          orgId: actor.orgId,
          userId: actor.userId,
          actorKind: actor.kind,
          type: "tag.removed",
          docId: targetKind === "doc" ? targetId : undefined,
          // Same as the apply above: the document's room rides on the row so un-filing is visible
          // in the room the document lives in.
          projectId: targetKind === "project" ? targetId : (target.homeProjectId ?? undefined),
          meta: { tagId, tagName: removed.name, tagSlug: removed.slug, targetKind, ...who },
          request,
        });
      }

      return applyTempUserHeaders(NextResponse.json({ ok: true, tags }), actor);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not remove the tag";
      return applyTempUserHeaders(NextResponse.json({ error: message }, { status: 400 }), actor);
    }
  });
}
