/**
 * API route for `/api/orgs/:orgId/members/:userId/revoke`.
 *
 * Revoke (remove) an org membership (owner/admin permissions).
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { membershipChanged, resolveActor } from "@/lib/gating/actor";
import { UserModel } from "@/lib/models/User";
import { recordActivity } from "@/lib/activity/log";
import { OrgModel } from "@/lib/models/Org";
import { sendMemberRemovedEmail } from "@/lib/email/sendMemberRemovedEmail";
import { debugError } from "@/lib/debug";
import { forbidApiKey } from "@/lib/gating/forbidApiKey";

export const runtime = "nodejs";

export async function POST(request: Request, ctx: { params: Promise<{ orgId: string; userId: string }> }) {
  const actor = await resolveActor(request);
  // Identity-grade: a key may not remove a member — see forbidApiKey.
  const keyRefusal = forbidApiKey(actor, "remove a member");
  if (keyRefusal) return keyRefusal;
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

  // Read the people before the write, not after: the sentence in the feed has to survive this
  // account being deleted later, so the name and address are copied into the event rather than
  // looked up when it is rendered. The remover comes along in the same query because the email
  // below says who did it, and two reads for two names is one read too many.
  const people = (await UserModel.find({ _id: { $in: [targetObjectId, actorUserId] } })
    .select({ _id: 1, name: 1, email: 1 })
    .lean()) as Array<{ _id: Types.ObjectId; name?: string | null; email?: string | null }>;
  const removed = people.find((p) => String(p._id) === targetUserId) ?? null;
  const remover = people.find((p) => String(p._id) === actor.userId) ?? null;

  await OrgMembershipModel.updateOne(
    { orgId: orgObjectId, userId: targetObjectId },
    { $set: { isDeleted: true, updatedDate: new Date() } },
  );

  // Removal is a security action, so the cached "yes, a member" answer goes immediately rather than
  // ageing out over the next ten seconds (see `membershipChanged`).
  membershipChanged({ orgId, userId: targetUserId });

  void recordActivity({
    orgId,
    userId: actor.userId,
    actorKind: "user",
    type: "member.removed",
    meta: {
      role: targetRole,
      targetUserId,
      name: removed?.name?.trim() || null,
      email: removed?.email?.trim().toLowerCase() || null,
    },
    request,
  });

  // Tell them. Losing access is otherwise something a person discovers from a page that suddenly
  // shows nothing, and the Remove dialog promises this email.
  //
  // Strictly best-effort, and deliberately not awaited: the membership is already gone, so a mail
  // provider having a bad minute must not turn a completed removal into an error the caller
  // retries — a retry would re-run the whole route against a membership that no longer exists.
  const removedEmail = removed?.email?.trim().toLowerCase() || "";
  if (removedEmail) {
    void (async () => {
      try {
        const org = (await OrgModel.findById(orgObjectId).select({ name: 1 }).lean()) as { name?: unknown } | null;
        await sendMemberRemovedEmail({
          to: removedEmail,
          orgName: typeof org?.name === "string" ? org.name : "",
          removedByEmail: remover?.email?.trim().toLowerCase() || null,
        });
      } catch (err) {
        debugError(1, "[api/orgs/members/revoke] member-removed email failed", err);
      }
    })();
  }

  return NextResponse.json({ ok: true, orgId, userId: targetUserId });
}



