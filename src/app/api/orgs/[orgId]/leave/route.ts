/**
 * API route for `/api/orgs/:orgId/leave`.
 *
 * Leave a team org (membership soft-delete). Personal orgs cannot be left.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { OrgModel } from "@/lib/models/Org";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { UserModel } from "@/lib/models/User";
import { membershipChanged, resolveActor } from "@/lib/gating/actor";
import { recordActivity } from "@/lib/activity/log";
import { ACTIVE_ORG_COOKIE } from "@/lib/orgs/activeOrgCookie";

export const runtime = "nodejs";

export async function POST(request: Request, ctx: { params: Promise<{ orgId: string }> }) {
  const actor = await resolveActor(request);
  if (actor.kind !== "user") return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

  const { orgId: orgIdRaw } = await ctx.params;
  const orgId = (orgIdRaw ?? "").trim();
  if (!Types.ObjectId.isValid(orgId)) return NextResponse.json({ error: "Invalid orgId" }, { status: 400 });

  // Never allow leaving your personal org.
  if (orgId === actor.personalOrgId) {
    return NextResponse.json({ error: "Cannot leave personal org" }, { status: 400 });
  }

  await connectMongo();
  const orgObjectId = new Types.ObjectId(orgId);
  const userObjectId = new Types.ObjectId(actor.userId);

  const org = await OrgModel.findOne({ _id: orgObjectId, isDeleted: { $ne: true } })
    .select({ type: 1 })
    .lean();
  const orgType = org ? String((org as { type?: unknown }).type ?? "") : "";
  if (!org || orgType !== "team") return NextResponse.json({ error: "Not found" }, { status: 404 });

  const membership = await OrgMembershipModel.findOne({ orgId: orgObjectId, userId: userObjectId, isDeleted: { $ne: true } })
    .select({ role: 1 })
    .lean();
  if (!membership) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const role = String((membership as { role?: unknown }).role ?? "");
  if (role === "owner") {
    return NextResponse.json({ error: "Owners cannot leave their org" }, { status: 400 });
  }

  const leaving = (await UserModel.findById(userObjectId).select({ name: 1, email: 1 }).lean()) as
    | { name?: string | null; email?: string | null }
    | null;

  await OrgMembershipModel.updateOne(
    { orgId: orgObjectId, userId: userObjectId },
    { $set: { isDeleted: true, updatedDate: new Date() } },
  );

  membershipChanged({ orgId, userId: actor.userId });

  // The workspace they left still gets to know: the people still in it see one person fewer on the
  // Members page and, without this, nothing that says when or who.
  void recordActivity({
    orgId,
    userId: actor.userId,
    actorKind: "user",
    type: "member.left",
    meta: { role, name: leaving?.name?.trim() || null, email: leaving?.email?.trim().toLowerCase() || null },
    request,
  });

  // If the user is currently in this org, switch them back to their personal org.
  const shouldSwitch = actor.orgId === orgId;
  const res = NextResponse.json({
    ok: true,
    leftOrgId: orgId,
    switchedToOrgId: shouldSwitch ? actor.personalOrgId : null,
  });

  if (shouldSwitch) {
    await UserModel.updateOne(
      { _id: userObjectId },
      { $set: { "metadata.activeOrgId": actor.personalOrgId, lastLoginAt: new Date() } },
    );
    res.cookies.set(ACTIVE_ORG_COOKIE, actor.personalOrgId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }

  return res;
}



