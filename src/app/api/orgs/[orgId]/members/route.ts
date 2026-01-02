/**
 * API route for `/api/orgs/:orgId/members`.
 *
 * List members of an org (owner/admin only) so workspace admins can manage invites and visibility.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { UserModel } from "@/lib/models/User";
import { resolveActor } from "@/lib/gating/actor";

export const runtime = "nodejs";

export async function GET(request: Request, ctx: { params: Promise<{ orgId: string }> }) {
  const actor = await resolveActor(request);
  if (actor.kind !== "user") return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

  const { orgId: orgIdRaw } = await ctx.params;
  const orgId = (orgIdRaw ?? "").trim();
  if (!Types.ObjectId.isValid(orgId)) return NextResponse.json({ error: "Invalid orgId" }, { status: 400 });

  await connectMongo();
  const orgObjectId = new Types.ObjectId(orgId);
  const userObjectId = new Types.ObjectId(actor.userId);

  const membership = await OrgMembershipModel.findOne({ orgId: orgObjectId, userId: userObjectId, isDeleted: { $ne: true } })
    .select({ role: 1 })
    .lean();
  const role = membership ? String((membership as { role?: unknown }).role ?? "") : "";
  const canView = role === "owner" || role === "admin";
  if (!canView) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const memberships = await OrgMembershipModel.find({ orgId: orgObjectId, isDeleted: { $ne: true } })
    .select({ userId: 1, role: 1, createdDate: 1 })
    .lean();

  const userIds = memberships
    .map((m) => (m as { userId?: unknown }).userId)
    .filter((v): v is Types.ObjectId => v instanceof Types.ObjectId);

  const users = await UserModel.find({ _id: { $in: userIds } })
    .select({ email: 1, name: 1, role: 1, isTemp: 1, isActive: 1, lastLoginAt: 1 })
    .lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));

  const items = memberships.map((m) => {
    const userId = (m as { userId?: unknown }).userId instanceof Types.ObjectId ? String(m.userId) : "";
    const u = byId.get(userId) ?? null;
    return {
      userId,
      memberRole: typeof (m as { role?: unknown }).role === "string" ? (m as { role: string }).role : null,
      email: u && typeof u.email === "string" ? u.email : null,
      name: u && typeof u.name === "string" ? u.name : null,
      userRole: u && typeof (u as { role?: unknown }).role === "string" ? (u as { role: string }).role : null,
      isTemp: Boolean(u && (u as { isTemp?: unknown }).isTemp),
      isActive: u ? (u as { isActive?: unknown }).isActive !== false : false,
      lastLoginAt: u && u.lastLoginAt ? new Date(u.lastLoginAt).toISOString() : null,
      joinedAt: (m as { createdDate?: unknown }).createdDate instanceof Date ? m.createdDate.toISOString() : null,
    };
  });

  const roleOrder = new Map([["owner", 0], ["admin", 1], ["member", 2], ["viewer", 3]]);
  items.sort((a, b) => {
    const ra = roleOrder.get((a.memberRole ?? "").toLowerCase()) ?? 9;
    const rb = roleOrder.get((b.memberRole ?? "").toLowerCase()) ?? 9;
    if (ra !== rb) return ra - rb;
    const ea = (a.email ?? "").toLowerCase();
    const eb = (b.email ?? "").toLowerCase();
    if (ea !== eb) return ea < eb ? -1 : 1;
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
  });

  return NextResponse.json({ ok: true, orgId, members: items });
}



