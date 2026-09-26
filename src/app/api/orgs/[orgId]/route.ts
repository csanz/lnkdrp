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
import { SubscriptionModel } from "@/lib/models/Subscription";
import { WorkspaceCreditBalanceModel } from "@/lib/models/WorkspaceCreditBalance";
import { cancelStripeSubscriptionNow } from "@/lib/billing/stripeSubscriptionCancel";
import { logErrorEvent } from "@/lib/errors/logger";
import { resolveActor } from "@/lib/gating/actor";
import { ACTIVE_ORG_COOKIE } from "@/lib/orgs/activeOrgCookie";
import { forbidApiKey } from "@/lib/gating/forbidApiKey";
import {
  lockedHomeExclusionFor,
  projectGrantIds,
  projectVisibilityClause,
  revokeProjectGrants,
} from "@/lib/projects/lockScope";

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

  /**
   * The counts, as this admin may see them (docs/prds/lnkdrp-locked-projects.md, decisions 16 and 21).
   *
   * `canAdmin` above is a workspace role and the lock has no role term, so an owner or an admin who is
   * not in a private data room does not count it here either. That is the whole point of the no-bypass
   * rule: a number on the workspace settings page that is one higher than the project list is the
   * sentence "there is a room you cannot see", and the rooms people lock are the ones whose excluded
   * reader is senior.
   *
   * `documents` is filtered by the document's home for the same reason. The plan cap is the one count
   * in the product that deliberately still sees everything (decision 29), and it is not this one.
   */
  const counts = includeCounts
    ? {
        members: await OrgMembershipModel.countDocuments({ orgId: orgObjectId, isDeleted: { $ne: true } }),
        docs: await DocModel.countDocuments({
          orgId: orgObjectId,
          isDeleted: { $ne: true },
          ...(await lockedHomeExclusionFor(orgObjectId, actor.userId, request)),
        }),
        projects: await ProjectModel.countDocuments({
          orgId: orgObjectId,
          isDeleted: { $ne: true },
          $and: [projectVisibilityClause(await projectGrantIds(orgObjectId, actor.userId, request))],
        }),
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
  // Identity-grade: a key may not rename a workspace — see forbidApiKey.
  const keyRefusal = forbidApiKey(actor, "rename a workspace");
  if (keyRefusal) return keyRefusal;
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
  // Identity-grade: a key may not delete a workspace — see forbidApiKey.
  const keyRefusal = forbidApiKey(actor, "delete a workspace");
  if (keyRefusal) return keyRefusal;
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

  /**
   * Cancel in Stripe *before* soft-deleting anything.
   *
   * This route soft-deleted the org, its memberships, documents and uploads and never touched the
   * subscription. Stripe kept charging the card every month, and because the billing portal only
   * opens for the actor's *active* workspace (which needs a live membership), nobody could ever
   * reach that customer again from inside the product. If Stripe refuses or cannot be reached,
   * nothing is deleted: a workspace that still exists can be retried; an orphaned subscription
   * cannot.
   */
  const sub = (await SubscriptionModel.findOne({ orgId: orgObjectId, isDeleted: { $ne: true } })
    .select({ stripeSubscriptionId: 1, status: 1, interval: 1 })
    .lean()) as { stripeSubscriptionId?: string | null; status?: string; interval?: string | null } | null;
  const subscriptionId = (sub?.stripeSubscriptionId ?? "").trim();
  if (subscriptionId) {
    // Yearly Pro is prepaid: cancel with proration so the unused months land on the Stripe
    // customer's balance for support to refund, instead of vanishing with the workspace.
    const cancelled = await cancelStripeSubscriptionNow(subscriptionId, { prorate: sub?.interval === "year" });
    if (!cancelled.ok) {
      await logErrorEvent({
        severity: "error",
        category: "stripe",
        code: "STRIPE_CANCEL_FAILED",
        message: cancelled.error,
        request,
        route: "/api/orgs/[orgId]",
        method: "DELETE",
        statusCode: 502,
        ids: { workspaceId: orgId, userId: actor.userId },
      });
      return NextResponse.json(
        {
          error: "The workspace's subscription could not be cancelled, so nothing was deleted. Try again in a moment, or contact support.",
          code: "STRIPE_CANCEL_FAILED",
        },
        { status: 502 },
      );
    }
  }

  const now = new Date();

  // Soft-delete the org and detach access. We also soft-delete org-scoped content so it doesn't linger.
  await OrgModel.updateOne({ _id: orgObjectId }, { $set: { isDeleted: true, updatedDate: now } });
  if (sub) {
    // The Stripe side is already gone (above); mark the row so the webhook's `deleted` event for
    // it is a no-op and no read path can mistake this workspace for Pro.
    await SubscriptionModel.updateOne(
      { orgId: orgObjectId },
      { $set: { isDeleted: true, status: "free", planName: "Free", cancelAtPeriodEnd: false, currentPeriodEnd: null, updatedDate: now } },
    );
    await WorkspaceCreditBalanceModel.updateOne({ workspaceId: orgObjectId, onDemandEnabled: true }, { $set: { onDemandEnabled: false } });
  }
  await OrgMembershipModel.updateMany({ orgId: orgObjectId }, { $set: { isDeleted: true, updatedDate: now } });
  await OrgInviteModel.updateMany({ orgId: orgObjectId }, { $set: { isRevoked: true, updatedDate: now } });

  /**
   * Every grant into this workspace's private data rooms, through the one writer that clears them
   * (docs/prds/lnkdrp-locked-projects.md, decision 4).
   *
   * No `userId`: the rooms are going with the workspace, so this is all of them. It matters because
   * the sweep is a SOFT delete — the projects below keep their rows — so a grant left live here would
   * still be live if this workspace were ever restored, naming people who have since left.
   */
  await revokeProjectGrants({ orgId, now });

  await ProjectModel.updateMany({ orgId: orgObjectId, isDeleted: { $ne: true } }, { $set: { isDeleted: true, updatedDate: now } });
  await DocModel.updateMany(
    { orgId: orgObjectId, isDeleted: { $ne: true } },
    { $set: { isDeleted: true, deletedDate: now, updatedDate: now } },
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


