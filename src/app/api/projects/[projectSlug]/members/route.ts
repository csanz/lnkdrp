/**
 * API route for `/api/projects/:idOrSlug/members`: who is in a private data room
 * (docs/prds/lnkdrp-locked-projects.md, decisions 23 and 24).
 *
 * This is the one part of the feature that is a CHECK rather than a filter. Everywhere else a caller
 * who may not see a room is answered 404 with a body byte-identical to a room that never existed,
 * because a 403 on a read is a sentence reading "a private room with this name exists". Here the
 * caller has already passed the by-id filter and therefore demonstrably knows the room exists, so a
 * refusal can say what it means.
 *
 * All three methods refuse an API key. Membership is identity, and identity is not delegated to a
 * key: `lnk_` keys do document work (create links, read stats, replace a PDF), and the rule
 * `forbidApiKey` exists to enforce is that anything changing who has access needs the person, signed
 * in to the app.
 *
 * There is no owner or admin row here, and no owner or admin power over this list beyond being in it.
 * A workspace owner who is not in the room cannot read this route at all: the filter above answers
 * 404 for them exactly as it does for anybody else (decision 21).
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { recordActivity } from "@/lib/activity/log";
import { debugLog } from "@/lib/debug";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { forbidApiKey } from "@/lib/gating/forbidApiKey";
import { authOrRateLimitResponse, errorJson } from "@/lib/http/errorResponse";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { UserModel } from "@/lib/models/User";
import { connectMongo } from "@/lib/mongodb";
import { grantProjectMembership, LOCKED_ROOM_MEMBER_CAP, projectGrants, revokeProjectGrants } from "@/lib/projects/lockScope";
import { isLockedProject, resolveProjectForActor } from "@/lib/projects/resolveProject";
import { projectRoster } from "@/lib/projects/roster";
import { requireOrgRole } from "@/lib/orgs/requireOrgRole";

export const runtime = "nodejs";

/** One person's name and address, for the feed row a grant write always records. */
async function personFor(userId: string): Promise<{ name: string | null; email: string | null }> {
  if (!Types.ObjectId.isValid(userId)) return { name: null, email: null };
  const row = (await UserModel.findById(new Types.ObjectId(userId)).select({ name: 1, email: 1 }).lean()) as
    | { name?: unknown; email?: unknown }
    | null;
  return {
    name: typeof row?.name === "string" && row.name.trim() ? row.name.trim() : null,
    email: typeof row?.email === "string" && row.email.trim() ? row.email.trim().toLowerCase() : null,
  };
}

/**
 * `GET /api/projects/:idOrSlug/members`
 *
 * Out: `{ project, members[], candidates[], cap, membersCanManageLinks }`. Any workspace member who
 * can see the room may read it, viewers included, as with `GET .../docs`: the roster is who the room
 * is for, and a viewer who is in it needs to know who else is.
 *
 * `candidates` is the workspace's other live members, for the add control. That is the workspace
 * roster, which every member can already see in the feed and on every document, and it is only
 * reachable here by somebody who can see this room.
 */
export async function GET(request: Request, ctx: { params: Promise<{ projectSlug: string }> }) {
  try {
    const { projectSlug } = await ctx.params;
    const param = decodeURIComponent(projectSlug).trim();
    const actor = await resolveActor(request);
    const keyRefusal = forbidApiKey(actor, "read a data room's member list");
    if (keyRefusal) return keyRefusal;

    await connectMongo();
    const project = await resolveProjectForActor({ actor, param, request });
    if (!project) return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);

    const locked = isLockedProject(project);
    const roster = await projectRoster({
      orgId: actor.orgId,
      projectId: project._id,
      viewerUserId: actor.userId,
      locked,
      includeCandidates: true,
    });

    return applyTempUserHeaders(
      NextResponse.json(
        {
          project: {
            id: String(project._id),
            name: project.name ?? "",
            visibility: locked ? "locked" : "workspace",
            // The banner and the roster render a field rather than infer one (decision 23).
            visibleBecause: roster.visibleBecause,
            lockedAt: project.lockedAt instanceof Date ? project.lockedAt.toISOString() : null,
          },
          members: roster.members,
          candidates: roster.candidates,
          cap: LOCKED_ROOM_MEMBER_CAP,
          /**
           * Decision 24, said at the moment it becomes true: the workspace role still decides what
           * may be done, so a locked room whose members are all `member` or `viewer` cannot manage
           * its own share links, and the only people with the role cannot see it.
           */
          membersCanManageLinks: roster.membersCanManageLinks,
        },
        { headers: { "cache-control": "no-store" } },
      ),
      actor,
    );
  } catch (err) {
    const authOrLimited = authOrRateLimitResponse(err);
    if (authOrLimited) return authOrLimited;
    return errorJson(err, {
      status: 500,
      publicMessage: "Could not load the member list",
      context: "[api/projects/:id/members] GET failed",
    });
  }
}

/**
 * `POST /api/projects/:idOrSlug/members` — add somebody to the room.
 *
 * In: `{ userId, role: "editor" | "reader" }`. `role` is required and has no default, for the reason
 * the model has none: "editor" is a real power and a writer that forgets to say so should be refused
 * rather than quietly handed it.
 *
 * Refused: an API key (identity work), a caller without the `member` workspace role, somebody who is
 * not a live member of this workspace (v1 has no guests), and the two-hundred-and-first person.
 *
 * Adding somebody shows them everything in the room, including what happened before they joined:
 * membership is present-tense, and the panel says so beside this control (open question 5).
 */
export async function POST(request: Request, ctx: { params: Promise<{ projectSlug: string }> }) {
  try {
    const { projectSlug } = await ctx.params;
    const param = decodeURIComponent(projectSlug).trim();
    const actor = await resolveActor(request);
    const keyRefusal = forbidApiKey(actor, "add someone to a data room");
    if (keyRefusal) return keyRefusal;
    // Viewers can read a workspace but must not change who is in a room inside it.
    const roleCheck = await requireOrgRole({ orgId: actor.orgId, userId: actor.userId, minRole: "member" });
    if (!roleCheck.ok) {
      return applyTempUserHeaders(NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status }), actor);
    }

    const body = (await request.json().catch(() => ({}))) as Partial<{ userId: string; role: string }>;
    const targetUserId = typeof body.userId === "string" ? body.userId.trim() : "";
    const role = body.role === "editor" || body.role === "reader" ? body.role : null;

    await connectMongo();
    const project = await resolveProjectForActor({ actor, param, request });
    if (!project) return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);

    if (!Types.ObjectId.isValid(targetUserId)) {
      return NextResponse.json({ error: "A workspace member is required" }, { status: 400 });
    }
    if (!role) {
      return NextResponse.json({ error: "A role of editor or reader is required" }, { status: 400 });
    }

    const orgId = new Types.ObjectId(actor.orgId);
    const membership = await OrgMembershipModel.exists({
      orgId,
      userId: new Types.ObjectId(targetUserId),
      isDeleted: { $ne: true },
    });
    if (!membership) {
      // Not a 404: the caller picked from a list, and "they are not in this workspace" is the true
      // and useful answer. Nothing about the room is disclosed by it.
      return NextResponse.json(
        { error: "That person is not a member of this workspace. Invite them first." },
        { status: 400 },
      );
    }

    const grants = await projectGrants({ orgId, projectId: project._id });
    if (!grants.some((g) => String(g.userId) === targetUserId) && grants.length >= LOCKED_ROOM_MEMBER_CAP) {
      return NextResponse.json(
        {
          error: `A data room can hold ${LOCKED_ROOM_MEMBER_CAP} people. Remove someone first, or unlock the room.`,
          code: "PROJECT_MEMBER_CAP",
        },
        { status: 409 },
      );
    }

    const { added } = await grantProjectMembership({
      orgId,
      projectId: project._id,
      userId: targetUserId,
      role,
      via: "added",
      addedByUserId: actor.userId,
    });

    if (added) {
      const person = await personFor(targetUserId);
      // Carries `projectId`, so it lives in the room's own feed and not the workspace one: every row
      // after the lock itself is about people inside a room only its members can see (decision 17).
      void recordActivity({
        orgId: actor.orgId,
        userId: actor.userId,
        actorKind: actor.kind,
        type: "project.member_added",
        projectId: project._id,
        title: project.name ?? null,
        meta: { projectName: project.name ?? null, targetUserId, name: person.name, email: person.email, role },
        request,
      });
    }
    debugLog(1, "[api/projects/:id/members] POST", { project: String(project._id), added });

    return applyTempUserHeaders(NextResponse.json({ ok: true, added }), actor);
  } catch (err) {
    const authOrLimited = authOrRateLimitResponse(err);
    if (authOrLimited) return authOrLimited;
    return errorJson(err, {
      status: 500,
      publicMessage: "Could not add that person to the data room",
      context: "[api/projects/:id/members] POST failed",
    });
  }
}

/**
 * `DELETE /api/projects/:idOrSlug/members` — remove somebody from the room.
 *
 * In: `{ userId }` in the body, or `?userId=`. Removing the last member of a LOCKED room is refused
 * with 409: an empty locked room is not a room with a caretaker, it is a room nobody can open, and
 * break-glass is the only way back into one.
 *
 * Removing somebody does not change the room's share links. Anyone who saw a `/p/:shareId` URL keeps
 * recipient access, which is decision 26 and which the panel says beside this button.
 */
export async function DELETE(request: Request, ctx: { params: Promise<{ projectSlug: string }> }) {
  try {
    const { projectSlug } = await ctx.params;
    const param = decodeURIComponent(projectSlug).trim();
    const actor = await resolveActor(request);
    const keyRefusal = forbidApiKey(actor, "remove someone from a data room");
    if (keyRefusal) return keyRefusal;
    const roleCheck = await requireOrgRole({ orgId: actor.orgId, userId: actor.userId, minRole: "member" });
    if (!roleCheck.ok) {
      return applyTempUserHeaders(NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status }), actor);
    }

    const url = new URL(request.url);
    const body = (await request.json().catch(() => ({}))) as Partial<{ userId: string }>;
    const targetUserId = (typeof body.userId === "string" ? body.userId : (url.searchParams.get("userId") ?? "")).trim();

    await connectMongo();
    const project = await resolveProjectForActor({ actor, param, request });
    if (!project) return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    if (!Types.ObjectId.isValid(targetUserId)) {
      return NextResponse.json({ error: "A member is required" }, { status: 400 });
    }

    const orgId = new Types.ObjectId(actor.orgId);
    const grants = await projectGrants({ orgId, projectId: project._id });
    const target = grants.find((g) => String(g.userId) === targetUserId);
    if (!target) {
      // Idempotent: they are already out, which is the state the caller asked for.
      return applyTempUserHeaders(NextResponse.json({ ok: true, removed: false }), actor);
    }
    if (isLockedProject(project) && grants.length <= 1) {
      return NextResponse.json(
        {
          error: "This is the last person in a private data room. Unlock it or add someone first.",
          code: "LAST_PROJECT_MEMBER",
        },
        { status: 409 },
      );
    }

    await revokeProjectGrants({ orgId, userId: targetUserId, projectIds: [project._id] });

    const person = await personFor(targetUserId);
    void recordActivity({
      orgId: actor.orgId,
      userId: actor.userId,
      actorKind: actor.kind,
      type: "project.member_removed",
      projectId: project._id,
      title: project.name ?? null,
      meta: {
        projectName: project.name ?? null,
        targetUserId,
        name: person.name,
        email: person.email,
        role: target.role,
        ...(targetUserId === actor.userId ? { self: true } : {}),
      },
      request,
    });
    debugLog(1, "[api/projects/:id/members] DELETE", { project: String(project._id) });

    return applyTempUserHeaders(NextResponse.json({ ok: true, removed: true }), actor);
  } catch (err) {
    const authOrLimited = authOrRateLimitResponse(err);
    if (authOrLimited) return authOrLimited;
    return errorJson(err, {
      status: 500,
      publicMessage: "Could not remove that person from the data room",
      context: "[api/projects/:id/members] DELETE failed",
    });
  }
}
