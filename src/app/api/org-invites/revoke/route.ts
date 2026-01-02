/**
 * API route for `/api/org-invites/revoke`.
 *
 * Revoke (invalidate) an org invite link (owner/admin only).
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { OrgInviteModel } from "@/lib/models/OrgInvite";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { resolveActor } from "@/lib/gating/actor";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const actor = await resolveActor(request);
  if (actor.kind !== "user") return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as Partial<{ inviteId: string; orgId: string }>;
  const inviteId = typeof body.inviteId === "string" ? body.inviteId.trim() : "";
  const orgIdRaw = typeof body.orgId === "string" ? body.orgId.trim() : actor.orgId;
  if (!inviteId || !Types.ObjectId.isValid(inviteId)) return NextResponse.json({ error: "Invalid inviteId" }, { status: 400 });
  if (!orgIdRaw || !Types.ObjectId.isValid(orgIdRaw)) return NextResponse.json({ error: "Invalid orgId" }, { status: 400 });

  await connectMongo();

  const membership = await OrgMembershipModel.findOne({
    orgId: new Types.ObjectId(orgIdRaw),
    userId: new Types.ObjectId(actor.userId),
    isDeleted: { $ne: true },
  })
    .select({ role: 1 })
    .lean();
  const userRole = membership ? String((membership as { role?: unknown }).role ?? "") : "";
  const canInvite = userRole === "owner" || userRole === "admin";
  if (!canInvite) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const invite = await OrgInviteModel.findOne({
    _id: new Types.ObjectId(inviteId),
    orgId: new Types.ObjectId(orgIdRaw),
    isRevoked: { $ne: true },
  })
    .select({ redeemedAt: 1 })
    .lean();
  if (!invite) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const redeemedAt = (invite as unknown as { redeemedAt?: unknown }).redeemedAt;
  if (redeemedAt instanceof Date) {
    return NextResponse.json({ error: "Invite already used" }, { status: 400 });
  }

  await OrgInviteModel.updateOne(
    { _id: new Types.ObjectId(inviteId) },
    { $set: { isRevoked: true, updatedDate: new Date() } },
  );

  return NextResponse.json({ ok: true, inviteId });
}



