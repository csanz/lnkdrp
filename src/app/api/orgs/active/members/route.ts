/**
 * API route for `/api/orgs/active/members`.
 *
 * List members of the currently active org (workspace).
 * Auth required; any org member can call this (internal-only feature).
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { UserModel } from "@/lib/models/User";
import { resolveActor } from "@/lib/gating/actor";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const actor = await resolveActor(request);
  if (actor.kind !== "user") return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

  await connectMongo();
  const orgId = new Types.ObjectId(actor.orgId);
  const actorUserId = new Types.ObjectId(actor.userId);
  const ok = await OrgMembershipModel.exists({ orgId, userId: actorUserId, isDeleted: { $ne: true } });
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const memberships = await OrgMembershipModel.find({ orgId, isDeleted: { $ne: true } })
    .select({ userId: 1 })
    .lean();
  const userIds = memberships
    .map((m) => (m as any).userId)
    .filter((v): v is Types.ObjectId => v instanceof Types.ObjectId);
  const users = await UserModel.find({ _id: { $in: userIds }, isActive: { $ne: false } })
    .select({ _id: 1, name: 1, email: 1, isTemp: 1 })
    .lean();

  const items = users
    .map((u) => ({
      userId: String(u._id),
      name: typeof (u as any).name === "string" ? (u as any).name : null,
      email: typeof (u as any).email === "string" ? (u as any).email : null,
      isTemp: Boolean((u as any).isTemp),
    }))
    .sort((a, b) => {
      const an = (a.name ?? a.email ?? "").toLowerCase();
      const bn = (b.name ?? b.email ?? "").toLowerCase();
      if (an !== bn) return an < bn ? -1 : 1;
      return a.userId < b.userId ? -1 : 1;
    });

  return NextResponse.json({ ok: true, orgId: actor.orgId, members: items });
}


