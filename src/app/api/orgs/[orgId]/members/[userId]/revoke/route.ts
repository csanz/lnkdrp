/**
 * API route for `/api/orgs/:orgId/members/:userId/revoke`.
 *
 * Revoke (remove) an org membership (owner/admin permissions).
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { resolveActor } from "@/lib/gating/actor";

export const runtime = "nodejs";

export async function POST(request: Request, ctx: { params: Promise<{ orgId: string; userId: string }> }) {
  const actor = await resolveActor(request);
  if (actor.kind !== "user") return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

  const { orgId: orgIdRaw, userId: targetUserIdRaw } = await ctx.params;
  const orgId = (orgIdRaw ?? "").trim();
  const targetUserId = (targetUserIdRaw ?? "").trim();
  if (!Types.ObjectId.isValid(orgId)) return NextResponse.json({ error: "Invalid orgId" }, { status: 400 });
  if (!Types.ObjectId.isValid(targetUserId)) return NextResponse.json({ error: "Invalid userId" }, { status: 400 });

  if (targetUserId === actor.userId) return NextResponse.json({ error: "Use leave org to remove yourself" }, { status: 400 });

  await connectMongo();
  const orgObjectId = new Types.ObjectId(orgId);
  const actorUserId = new Types.ObjectId(actor.userId);
  const targetObjectId = new Types.ObjectId(targetUserId);

  const actorMembership = await OrgMembershipModel.findOne({ orgId: orgObjectId, userId: actorUserId, isDeleted: { $ne: true } })
    .select({ role: 1 })
    .lean();
  const actorRole = actorMembership ? String((actorMembership as { role?: unknown }).role ?? "") : "";
  const actorIsOwner = actorRole === "owner";
  const actorIsAdmin = actorRole === "admin";
  if (!actorIsOwner && !actorIsAdmin) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const targetMembership = await OrgMembershipModel.findOne({ orgId: orgObjectId, userId: targetObjectId, isDeleted: { $ne: true } })
    .select({ role: 1 })
    .lean();
  if (!targetMembership) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const targetRole = String((targetMembership as { role?: unknown }).role ?? "");

  // Permissions:
  // - Owner can remove admin/member/viewer (not owner).
  // - Admin can remove member/viewer (not owner/admin).
  if (targetRole === "owner") return NextResponse.json({ error: "Cannot remove owner" }, { status: 400 });
  if (actorIsAdmin && targetRole !== "member" && targetRole !== "viewer") {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  await OrgMembershipModel.updateOne(
    { orgId: orgObjectId, userId: targetObjectId },
    { $set: { isDeleted: true, updatedDate: new Date() } },
  );

  return NextResponse.json({ ok: true, orgId, userId: targetUserId });
}



