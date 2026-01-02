/**
 * Admin API route: `GET /api/admin/data/orgs/:orgId/members`
 *
 * Lists org members (user + membership role) for admin inspection.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { resolveActor } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { UserModel } from "@/lib/models/User";

export const runtime = "nodejs";

function isLocalhostRequest(request: Request) {
  if (process.env.NODE_ENV === "production") return false;
  const host = (request.headers.get("host") ?? "").toLowerCase();
  return host.startsWith("localhost:") || host.startsWith("127.0.0.1:");
}

async function requireAdmin(request: Request) {
  if (isLocalhostRequest(request)) {
    return { ok: true as const, userId: null as string | null };
  }
  const actor = await resolveActor(request);
  if (actor.kind !== "user" || !Types.ObjectId.isValid(actor.userId)) {
    return { ok: false as const, status: 401, error: "Not authenticated" };
  }

  await connectMongo();
  const u = await UserModel.findOne({ _id: new Types.ObjectId(actor.userId) })
    .select({ role: 1 })
    .lean();
  const role = (u as { role?: unknown } | null)?.role;
  if (role !== "admin") return { ok: false as const, status: 403, error: "Forbidden" };

  return { ok: true as const, userId: actor.userId };
}

export async function GET(request: Request, ctx: { params: Promise<{ orgId: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { orgId: orgIdRaw } = await ctx.params;
  const orgId = (orgIdRaw ?? "").trim();
  if (!Types.ObjectId.isValid(orgId)) return NextResponse.json({ error: "Invalid orgId" }, { status: 400 });

  await connectMongo();
  const orgObjectId = new Types.ObjectId(orgId);

  const memberships = await OrgMembershipModel.find({ orgId: orgObjectId, isDeleted: { $ne: true } })
    .select({ userId: 1, role: 1, createdDate: 1, updatedDate: 1 })
    .lean();

  const userIds = memberships
    .map((m) => (m as { userId?: unknown }).userId)
    .filter((v): v is Types.ObjectId => v instanceof Types.ObjectId);

  const users = await UserModel.find({ _id: { $in: userIds } })
    .select({ email: 1, name: 1, role: 1, isTemp: 1, isActive: 1, createdAt: 1, lastLoginAt: 1 })
    .lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));

  const items = memberships.map((m) => {
    const userId = (m as { userId?: unknown }).userId instanceof Types.ObjectId ? String(m.userId) : "";
    const u = byId.get(userId) ?? null;
    return {
      userId,
      memberRole: typeof (m as { role?: unknown }).role === "string" ? (m as { role: string }).role : null,
      memberCreatedDate: (m as { createdDate?: unknown }).createdDate instanceof Date ? m.createdDate.toISOString() : null,
      memberUpdatedDate: (m as { updatedDate?: unknown }).updatedDate instanceof Date ? m.updatedDate.toISOString() : null,
      email: u && typeof u.email === "string" ? u.email : null,
      name: u && typeof u.name === "string" ? u.name : null,
      userRole: u && typeof (u as { role?: unknown }).role === "string" ? (u as { role: string }).role : null,
      isTemp: Boolean(u && (u as { isTemp?: unknown }).isTemp),
      isActive: u ? (u as { isActive?: unknown }).isActive !== false : false,
      createdAt: u && u.createdAt ? new Date(u.createdAt).toISOString() : null,
      lastLoginAt: u && u.lastLoginAt ? new Date(u.lastLoginAt).toISOString() : null,
    };
  });

  // Stable sort: role then email then userId.
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



