/**
 * The roster of a private data room, as the app renders it (docs/prds/lnkdrp-locked-projects.md,
 * decisions 23 and 24).
 *
 * `GET /api/projects/:id` and `GET /api/projects/:id/members` both answer with this, so the members
 * panel and the project page cannot disagree about who is in a room. `visibleBecause` is a field
 * rather than something the client infers: a banner that guesses why it is being shown gets it wrong
 * the first time a grant's `via` changes.
 *
 * Names, not ids: "who is in this room" is unanswerable from a column of ObjectIds. The workspace
 * role rides along because decision 24 means a room can need a role none of its people hold, and the
 * panel says that at the moment it becomes true rather than when somebody discovers the Links button
 * does nothing.
 */
import { Types } from "mongoose";

import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { UserModel } from "@/lib/models/User";
import { projectGrants, type ProjectGrantRow } from "@/lib/projects/lockScope";

/** The workspace roles that can manage a project's share links (`accessProjectForLinks`). */
export const LINK_WRITE_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

/** One person in a room. */
export type ProjectMemberDto = {
  userId: string;
  name: string | null;
  email: string | null;
  /** The room role. It grants nothing on its own: the workspace role still decides (decision 24). */
  role: ProjectGrantRow["role"];
  via: ProjectGrantRow["via"];
  /** Their workspace role, so the panel can say when nobody here can manage the room's links. */
  orgRole: string | null;
  addedByUserId: string | null;
  /** The break-glass justification, shown to every existing member. Empty for ordinary grants. */
  reason: string;
  addedDate: string | null;
};

export type ProjectRoster = {
  members: ProjectMemberDto[];
  /** Why the viewer can see this room. `"workspace"` means it is not locked at all. */
  visibleBecause: "workspace" | "member" | "break_glass";
  /** False when nobody in the room holds a workspace role that can write its share links. */
  membersCanManageLinks: boolean;
  /** Live workspace members who are not in the room, for the add control. */
  candidates: Array<{ userId: string; name: string | null; email: string | null; orgRole: string | null }>;
};

/** A row's ObjectId as a string, or "" when the field is not one. */
function idOf(v: unknown): string {
  return v instanceof Types.ObjectId ? String(v) : typeof v === "string" ? v : "";
}

/**
 * Read one room's roster.
 *
 * `includeCandidates` is off by default because the project DTO does not need the whole workspace
 * roster to draw a lock icon, and the members panel is the one screen that does.
 */
export async function projectRoster(params: {
  orgId: Types.ObjectId | string;
  projectId: Types.ObjectId | string;
  viewerUserId: Types.ObjectId | string;
  /** False for an unlocked project: there is nothing to be a member of, and grants there are dormant. */
  locked: boolean;
  includeCandidates?: boolean;
}): Promise<ProjectRoster> {
  const empty: ProjectRoster = {
    members: [],
    visibleBecause: params.locked ? "member" : "workspace",
    membersCanManageLinks: true,
    candidates: [],
  };
  const grants = await projectGrants({ orgId: params.orgId, projectId: params.projectId });
  if (!grants.length && !params.includeCandidates) return empty;

  const orgMemberships = (await OrgMembershipModel.find({
    orgId: new Types.ObjectId(String(params.orgId)),
    isDeleted: { $ne: true },
  })
    .select({ userId: 1, role: 1 })
    .lean()) as Array<{ userId?: unknown; role?: unknown }>;
  const orgRoleById = new Map<string, string>();
  for (const m of orgMemberships) {
    const id = idOf(m.userId);
    if (id) orgRoleById.set(id, typeof m.role === "string" ? m.role : "");
  }

  const grantedIds = new Set(grants.map((g) => String(g.userId)));
  const wanted = params.includeCandidates ? new Set([...grantedIds, ...orgRoleById.keys()]) : grantedIds;
  const users = (await UserModel.find({
    _id: { $in: [...wanted].filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id)) },
  })
    .select({ _id: 1, name: 1, email: 1 })
    .lean()) as Array<{ _id: Types.ObjectId; name?: unknown; email?: unknown }>;
  const personById = new Map(
    users.map((u) => [
      String(u._id),
      {
        name: typeof u.name === "string" && u.name.trim() ? u.name.trim() : null,
        email: typeof u.email === "string" && u.email.trim() ? u.email.trim().toLowerCase() : null,
      },
    ]),
  );

  const members: ProjectMemberDto[] = grants.map((g) => {
    const id = String(g.userId);
    return {
      userId: id,
      name: personById.get(id)?.name ?? null,
      email: personById.get(id)?.email ?? null,
      role: g.role,
      via: g.via,
      orgRole: orgRoleById.get(id) ?? null,
      addedByUserId: g.addedByUserId ? String(g.addedByUserId) : null,
      reason: g.reason,
      addedDate: g.createdDate ? g.createdDate.toISOString() : null,
    };
  });

  const mine = grants.find((g) => String(g.userId) === String(params.viewerUserId));
  return {
    members,
    visibleBecause: !params.locked ? "workspace" : mine?.via === "break_glass" ? "break_glass" : "member",
    // An unlocked room is managed by the workspace's own roles, so the question does not arise there.
    membersCanManageLinks: !params.locked
      ? true
      : members.some((m) => LINK_WRITE_ROLES.has((m.orgRole ?? "").toLowerCase())),
    candidates: params.includeCandidates
      ? [...orgRoleById.keys()]
          .filter((id) => !grantedIds.has(id))
          .map((id) => ({
            userId: id,
            name: personById.get(id)?.name ?? null,
            email: personById.get(id)?.email ?? null,
            orgRole: orgRoleById.get(id) ?? null,
          }))
          .sort((a, b) => (a.name ?? a.email ?? "").localeCompare(b.name ?? b.email ?? ""))
      : [],
  };
}
