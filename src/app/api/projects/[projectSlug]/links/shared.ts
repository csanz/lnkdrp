/**
 * Shared plumbing for the project share-link routes
 * (`/api/projects/:projectId/links[/:linkId]`, docs/prds/lnkdrp-project-links.md).
 *
 * Colocated with the routes (not a route file itself, so Next ignores it). It is the project-shaped
 * twin of `src/app/api/docs/[docId]/links/shared.ts`: the actor + membership check with the same
 * legacy no-workspace fallback the project routes use, and nothing else. The `planWarning` shape
 * and the `ShareLinkError` mapper are imported from that file rather than copied, so document and
 * project links cannot drift on what a plan warning or a 404 looks like.
 *
 * The route param is called `projectSlug` for historical reasons; it has always carried a project
 * **id** (`/api/projects/6aac1169…`), which is what the project pages address too.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { ProjectModel } from "@/lib/models/Project";
import { applyTempUserHeaders, resolveActor, type Actor } from "@/lib/gating/actor";
import { requireOrgRole, type OrgRole } from "@/lib/orgs/requireOrgRole";

export { linkErrorResponse, planWarningOf, type PlanWarning } from "@/app/api/docs/[docId]/links/shared";

export type ProjectAccess = {
  actor: Actor;
  projectId: Types.ObjectId;
  /** The workspace the project belongs to (backfilled for legacy personal projects). */
  orgId: Types.ObjectId;
  name: string | null;
};

export type ProjectAccessResult = { ok: true; access: ProjectAccess } | { ok: false; response: Response };

/**
 * Resolve the caller and the project they addressed, enforcing `minRole` in the workspace.
 *
 * Mirrors `PATCH /api/projects/:id`: org-scoped lookup with a fallback to legacy projects that have
 * no `orgId` yet (those are adopted here, as the doc link gate does, so the link service — which is
 * strictly org-scoped — can find them). The fallback only applies in the caller's *personal*
 * workspace: in a shared org a project with no `orgId` is not theirs to adopt.
 */
export async function accessProjectForLinks(
  request: Request,
  projectIdRaw: string,
  minRole: OrgRole,
): Promise<ProjectAccessResult> {
  const actor = await resolveActor(request);
  const id = decodeURIComponent(projectIdRaw ?? "").trim();
  if (!Types.ObjectId.isValid(id)) {
    return { ok: false, response: applyTempUserHeaders(NextResponse.json({ error: "Invalid projectId" }, { status: 400 }), actor) };
  }
  const roleCheck = await requireOrgRole({ orgId: actor.orgId, userId: actor.userId, minRole });
  if (!roleCheck.ok) {
    return { ok: false, response: applyTempUserHeaders(NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status }), actor) };
  }

  await connectMongo();
  const projectId = new Types.ObjectId(id);
  const orgId = new Types.ObjectId(actor.orgId);
  const legacyUserId = new Types.ObjectId(actor.userId);
  const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
  const match = allowLegacyByUserId
    ? {
        $or: [
          { _id: projectId, orgId },
          { _id: projectId, userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
        ],
      }
    : { _id: projectId, orgId };

  const project = (await ProjectModel.findOne({ ...match, isDeleted: { $ne: true } })
    .select({ _id: 1, orgId: 1, name: 1 })
    .lean()) as { _id: Types.ObjectId; orgId?: Types.ObjectId | null; name?: string | null } | null;
  if (!project) {
    return { ok: false, response: applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor) };
  }

  // Legacy personal project with no workspace yet: adopt it into the actor's org so the link
  // service (which always scopes by orgId) can see it. Best-effort, like the doc link gate.
  if (!project.orgId) {
    try {
      await ProjectModel.updateOne({ _id: projectId }, { $set: { orgId } });
      project.orgId = orgId;
    } catch {
      // ignore; best-effort
    }
  }

  return {
    ok: true,
    access: {
      actor,
      projectId,
      orgId: project.orgId ?? orgId,
      name: typeof project.name === "string" ? project.name : null,
    },
  };
}
