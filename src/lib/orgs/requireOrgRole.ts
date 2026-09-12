/**
 * Org role guard for mutating API routes.
 *
 * Org membership is the tenancy boundary, but membership alone is not authorization: viewers can
 * read a workspace and must not be able to edit or delete anything in it. This helper resolves the
 * caller's role in an org and compares it against a minimum.
 *
 * Role ranking (highest first): owner > admin > member > viewer.
 */
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { OrgModel } from "@/lib/models/Org";

export type OrgRole = "owner" | "admin" | "member" | "viewer";

const ROLE_RANK: Record<OrgRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export type RequireOrgRoleInput = {
  orgId: string | Types.ObjectId;
  userId: string | Types.ObjectId;
  /** Lowest role that passes. */
  minRole: OrgRole;
};

export type RequireOrgRoleResult =
  | { ok: true; role: OrgRole }
  | { ok: false; status: 403; error: string };

/** Return whether `role` is a known org role. */
export function isOrgRole(role: unknown): role is OrgRole {
  return typeof role === "string" && Object.prototype.hasOwnProperty.call(ROLE_RANK, role);
}

/** Return whether `role` is at least `minRole` in the owner > admin > member > viewer ordering. */
export function roleAtLeast(role: OrgRole, minRole: OrgRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

/**
 * Check that `userId` holds at least `minRole` in `orgId`.
 *
 * Personal orgs: the user the org belongs to always passes as `owner` (even if the membership row
 * is missing or stale), since a personal workspace has exactly one legitimate editor.
 *
 * Returns `{ ok: false, status: 403 }` for invalid ids, missing/deleted memberships, or
 * insufficient roles. Callers decide how to render the 403.
 */
export async function requireOrgRole(input: RequireOrgRoleInput): Promise<RequireOrgRoleResult> {
  const orgIdRaw = String(input.orgId ?? "").trim();
  const userIdRaw = String(input.userId ?? "").trim();
  if (!Types.ObjectId.isValid(orgIdRaw) || !Types.ObjectId.isValid(userIdRaw)) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const orgId = new Types.ObjectId(orgIdRaw);
  const userId = new Types.ObjectId(userIdRaw);

  await connectMongo();

  const membership = await OrgMembershipModel.findOne({ orgId, userId, isDeleted: { $ne: true } })
    .select({ role: 1 })
    .lean();
  const role = (membership as { role?: unknown } | null)?.role;
  if (isOrgRole(role) && roleAtLeast(role, input.minRole)) {
    return { ok: true, role };
  }

  // Personal org: the owning user passes regardless of membership state.
  const personal = await OrgModel.exists({
    _id: orgId,
    type: "personal",
    personalForUserId: userId,
    isDeleted: { $ne: true },
  });
  if (personal) return { ok: true, role: "owner" };

  return { ok: false, status: 403, error: "Forbidden" };
}
