/**
 * API route for `/api/orgs/:orgId`.
 *
 * - GET: return org details and safety counts for management UIs (owner/admin only).
 * - PATCH: update org name (owner/admin only; personal org name allowed).
 * - DELETE: soft-delete an org (owner only; cannot delete personal org).
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { OrgModel } from "@/lib/models/Org";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { OrgInviteModel } from "@/lib/models/OrgInvite";
import { DocModel } from "@/lib/models/Doc";
import { ProjectModel } from "@/lib/models/Project";
import { UploadModel } from "@/lib/models/Upload";
import { UserModel } from "@/lib/models/User";
import { resolveActor } from "@/lib/gating/actor";
import { ACTIVE_ORG_COOKIE } from "@/app/api/orgs/active/route";

export const runtime = "nodejs";

function normalizeConfirm(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

async function requireMembershipRole(opts: { orgId: Types.ObjectId; userId: Types.ObjectId }) {
  const membership = await OrgMembershipModel.findOne({ orgId: opts.orgId, userId: opts.userId, isDeleted: { $ne: true } })
    .select({ role: 1 })
    .lean();
  const role = membership ? String((membership as { role?: unknown }).role ?? "") : "";
  const canAdmin = role === "owner" || role === "admin";
  const isOwner = role === "owner";
  return { role, canAdmin, isOwner };
}

export async function GET(request: Request, ctx: { params: Promise<{ orgId: string }> }) {
  const actor = await resolveActor(request);
  if (actor.kind !== "user") return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

  const { orgId: orgIdRaw } = await ctx.params;
  const orgId = (orgIdRaw ?? "").trim();
  if (!Types.ObjectId.isValid(orgId)) return NextResponse.json({ error: "Invalid orgId" }, { status: 400 });

  const url = new URL(request.url);
  const includeCounts = (url.searchParams.get("includeCounts") ?? "").trim() === "1";

  await connectMongo();
  const orgObjectId = new Types.ObjectId(orgId);
  const userObjectId = new Types.ObjectId(actor.userId);

  const { canAdmin } = await requireMembershipRole({ orgId: orgObjectId, userId: userObjectId });
  if (!canAdmin) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const org = await OrgModel.findOne({ _id: orgObjectId, isDeleted: { $ne: true } })
    .select({ _id: 1, type: 1, name: 1, slug: 1, avatarUrl: 1, personalForUserId: 1, createdByUserId: 1 })
    .lean();
  if (!org) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const counts = includeCounts
    ? {
        members: await OrgMembershipModel.countDocuments({ orgId: orgObjectId, isDeleted: { $ne: true } }),
        docs: await DocModel.countDocuments({ orgId: orgObjectId, isDeleted: { $ne: true } }),
        projects: await ProjectModel.countDocuments({ orgId: orgObjectId, isDeleted: { $ne: true } }),
        uploads: await UploadModel.countDocuments({ orgId: orgObjectId, isDeleted: { $ne: true } }),
        invites: await OrgInviteModel.countDocuments({ orgId: orgObjectId, isRevoked: { $ne: true } }),
      }
    : null;

  return NextResponse.json({
    ok: true,
    org: {
      id: String(org._id),
      type: String((org as { type?: unknown }).type ?? ""),
      name: String((org as { name?: unknown }).name ?? ""),
      slug: (org as { slug?: unknown }).slug ?? null,
      avatarUrl: (org as { avatarUrl?: unknown }).avatarUrl ?? null,
      createdByUserId: (org as { createdByUserId?: unknown }).createdByUserId
        ? String((org as { createdByUserId: Types.ObjectId }).createdByUserId)
        : null,
    },
    counts,
  });
}

export async function PATCH(request: Request, ctx: { params: Promise<{ orgId: string }> }) {
  const actor = await resolveActor(request);
  if (actor.kind !== "user") return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

  const { orgId: orgIdRaw } = await ctx.params;
  const orgId = (orgIdRaw ?? "").trim();
  if (!Types.ObjectId.isValid(orgId)) return NextResponse.json({ error: "Invalid orgId" }, { status: 400 });

  const body = (await request.json().catch(() => ({}))) as Partial<{ name: string }>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "Org name is required" }, { status: 400 });
  if (name.length > 80) return NextResponse.json({ error: "Org name too long" }, { status: 400 });

  await connectMongo();
  const orgObjectId = new Types.ObjectId(orgId);
  const userObjectId = new Types.ObjectId(actor.userId);

  const { canAdmin } = await requireMembershipRole({ orgId: orgObjectId, userId: userObjectId });
  if (!canAdmin) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const updated = await OrgModel.findOneAndUpdate(
    { _id: orgObjectId, isDeleted: { $ne: true } },
    { $set: { name, updatedDate: new Date() } },
    { new: true },
  )
    .select({ _id: 1, name: 1 })
    .lean();
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ ok: true, org: { id: orgId, name: String((updated as any).name ?? name) } });
}

export async function DELETE(request: Request, ctx: { params: Promise<{ orgId: string }> }) {
  const actor = await resolveActor(request);
  if (actor.kind !== "user") return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

  const { orgId: orgIdRaw } = await ctx.params;
  const orgId = (orgIdRaw ?? "").trim();
  if (!Types.ObjectId.isValid(orgId)) return NextResponse.json({ error: "Invalid orgId" }, { status: 400 });

  // Never allow deleting your personal org.
  if (orgId === actor.personalOrgId) {
    return NextResponse.json({ error: "Cannot delete personal org" }, { status: 400 });
  }

  const body = (await request.json().catch(() => ({}))) as Partial<{ confirm: string }>;
  const confirm = typeof body.confirm === "string" ? normalizeConfirm(body.confirm) : "";

  await connectMongo();
  const orgObjectId = new Types.ObjectId(orgId);
  const userObjectId = new Types.ObjectId(actor.userId);

  const { isOwner } = await requireMembershipRole({ orgId: orgObjectId, userId: userObjectId });
  if (!isOwner) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const org = await OrgModel.findOne({ _id: orgObjectId, isDeleted: { $ne: true } })
    .select({ _id: 1, name: 1, type: 1 })
    .lean();
  const orgName = org ? String((org as { name?: unknown }).name ?? "").trim() : "";
  const orgType = org ? String((org as { type?: unknown }).type ?? "") : "";
  if (!org || orgType !== "team") return NextResponse.json({ error: "Not found" }, { status: 404 });

  const expected = normalizeConfirm(`delete ${orgName}`);
  if (!confirm || confirm !== expected) {
    return NextResponse.json({ error: `Confirm by typing: ${expected}` }, { status: 400 });
  }

  const now = new Date();

  // Soft-delete the org and detach access. We also soft-delete org-scoped content so it doesn't linger.
  await OrgModel.updateOne({ _id: orgObjectId }, { $set: { isDeleted: true, updatedDate: now } });
  await OrgMembershipModel.updateMany({ orgId: orgObjectId }, { $set: { isDeleted: true, updatedDate: now } });
  await OrgInviteModel.updateMany({ orgId: orgObjectId }, { $set: { isRevoked: true, updatedDate: now } });

  await ProjectModel.updateMany({ orgId: orgObjectId, isDeleted: { $ne: true } }, { $set: { isDeleted: true, updatedDate: now } });
  await DocModel.updateMany(
    { orgId: orgObjectId, isDeleted: { $ne: true } },
    { $set: { isDeleted: true, deletedDate: now, isDeletedDate: now, updatedDate: now } },
  );
  await UploadModel.updateMany({ orgId: orgObjectId, isDeleted: { $ne: true } }, { $set: { isDeleted: true, updatedDate: now } });

  const shouldSwitch = actor.orgId === orgId;
  const res = NextResponse.json({ ok: true, deletedOrgId: orgId, switchedToOrgId: shouldSwitch ? actor.personalOrgId : null });

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


