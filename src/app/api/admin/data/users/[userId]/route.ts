/**
 * Admin API route: `GET /api/admin/data/users/:userId`, `DELETE /api/admin/data/users/:userId`
 *
 * GET returns a user record (admin-only) plus org memberships for inspection. DELETE disables the
 * account: it does not remove the row, and it takes away the API keys as well as the session (see
 * the DELETE handler for why the keys are part of it).
 *
 * Notes:
 * - Intentionally does NOT return temp-user secrets/hashes.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { ApiKeyModel } from "@/lib/models/ApiKey";
import { OrgModel } from "@/lib/models/Org";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { UserModel } from "@/lib/models/User";
import { accountDisabledChanged } from "@/lib/gating/actor";
import { requireAdmin } from "@/lib/gating/requireAdmin";

export const runtime = "nodejs";



/**
 *
 */
export async function GET(request: Request, ctx: { params: Promise<{ userId: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { userId: userIdRaw } = await ctx.params;
  const userId = (userIdRaw ?? "").trim();
  if (!Types.ObjectId.isValid(userId)) return NextResponse.json({ error: "Invalid userId" }, { status: 400 });

  await connectMongo();
  const userObjectId = new Types.ObjectId(userId);

  const u = await UserModel.findOne({ _id: userObjectId })
    .select({
      isTemp: 1,
      email: 1,
      name: 1,
      image: 1,
      authProvider: 1,
      providerAccountId: 1,
      createdAt: 1,
      lastLoginAt: 1,
      isActive: 1,
      role: 1,
      plan: 1,
      stripeCustomerId: 1,
      stripeSubscriptionId: 1,
      stripeSubscriptionStatus: 1,
      stripeCurrentPeriodEnd: 1,
      spendLimitCents: 1,
      spendUsedCentsThisPeriod: 1,
      onboardingCompleted: 1,
      metadata: 1,
    })
    .lean();
  if (!u) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const memberships = await OrgMembershipModel.find({ userId: userObjectId, isDeleted: { $ne: true } })
    .select({ orgId: 1, role: 1, docUpdateEmailMode: 1, repoLinkRequestEmailMode: 1, createdDate: 1, updatedDate: 1 })
    .lean();

  const orgIds = memberships
    .map((m) => (m as { orgId?: unknown }).orgId)
    .filter((v): v is Types.ObjectId => v instanceof Types.ObjectId);

  const orgs = await OrgModel.find({ _id: { $in: orgIds }, isDeleted: { $ne: true } })
    .select({ type: 1, name: 1, slug: 1, personalForUserId: 1, createdByUserId: 1, createdDate: 1, updatedDate: 1 })
    .lean();
  const orgById = new Map(orgs.map((o) => [String(o._id), o]));

  const items = memberships
    .map((m) => {
      const orgId = (m as { orgId?: unknown }).orgId instanceof Types.ObjectId ? String(m.orgId) : "";
      const org = orgId ? orgById.get(orgId) ?? null : null;
      if (!orgId || !org) return null;
      return {
        orgId,
        orgType: typeof (org as { type?: unknown }).type === "string" ? (org as { type: string }).type : null,
        orgName: typeof (org as { name?: unknown }).name === "string" ? (org as { name: string }).name : null,
        orgSlug: typeof (org as { slug?: unknown }).slug === "string" ? (org as { slug: string }).slug : null,
        membershipRole: typeof (m as { role?: unknown }).role === "string" ? (m as { role: string }).role : null,
        docUpdateEmailMode:
          typeof (m as { docUpdateEmailMode?: unknown }).docUpdateEmailMode === "string"
            ? (m as { docUpdateEmailMode: string }).docUpdateEmailMode
            : null,
        repoLinkRequestEmailMode:
          typeof (m as { repoLinkRequestEmailMode?: unknown }).repoLinkRequestEmailMode === "string"
            ? (m as { repoLinkRequestEmailMode: string }).repoLinkRequestEmailMode
            : null,
        membershipCreatedDate: (m as { createdDate?: unknown }).createdDate instanceof Date ? m.createdDate.toISOString() : null,
        membershipUpdatedDate: (m as { updatedDate?: unknown }).updatedDate instanceof Date ? m.updatedDate.toISOString() : null,
      };
    })
    .filter((x): x is NonNullable<typeof x> => Boolean(x));

  // Stable sort: team before personal, then org name.
  const typeOrder = new Map([["team", 0], ["personal", 1]]);
  items.sort((a, b) => {
    const ta = typeOrder.get((a.orgType ?? "").toLowerCase()) ?? 9;
    const tb = typeOrder.get((b.orgType ?? "").toLowerCase()) ?? 9;
    if (ta !== tb) return ta - tb;
    const na = (a.orgName ?? "").toLowerCase();
    const nb = (b.orgName ?? "").toLowerCase();
    if (na !== nb) return na < nb ? -1 : 1;
    return a.orgId < b.orgId ? -1 : a.orgId > b.orgId ? 1 : 0;
  });

  return NextResponse.json({
    ok: true,
    userId,
    user: {
      id: String((u as any)._id),
      isTemp: Boolean((u as any).isTemp),
      email: typeof (u as any).email === "string" ? String((u as any).email) : null,
      name: typeof (u as any).name === "string" ? String((u as any).name) : null,
      image: typeof (u as any).image === "string" ? String((u as any).image) : null,
      authProvider: typeof (u as any).authProvider === "string" ? String((u as any).authProvider) : null,
      providerAccountId: typeof (u as any).providerAccountId === "string" ? String((u as any).providerAccountId) : null,
      createdAt: (u as any).createdAt instanceof Date ? (u as any).createdAt.toISOString() : null,
      lastLoginAt: (u as any).lastLoginAt instanceof Date ? (u as any).lastLoginAt.toISOString() : null,
      isActive: (u as any).isActive !== false,
      role: typeof (u as any).role === "string" ? String((u as any).role) : null,
      plan: typeof (u as any).plan === "string" ? String((u as any).plan) : null,
      stripeCustomerId: typeof (u as any).stripeCustomerId === "string" ? String((u as any).stripeCustomerId) : null,
      stripeSubscriptionId: typeof (u as any).stripeSubscriptionId === "string" ? String((u as any).stripeSubscriptionId) : null,
      stripeSubscriptionStatus: typeof (u as any).stripeSubscriptionStatus === "string" ? String((u as any).stripeSubscriptionStatus) : null,
      stripeCurrentPeriodEnd: (u as any).stripeCurrentPeriodEnd instanceof Date ? (u as any).stripeCurrentPeriodEnd.toISOString() : null,
      spendLimitCents: typeof (u as any).spendLimitCents === "number" ? (u as any).spendLimitCents : null,
      spendUsedCentsThisPeriod: typeof (u as any).spendUsedCentsThisPeriod === "number" ? (u as any).spendUsedCentsThisPeriod : null,
      onboardingCompleted: Boolean((u as any).onboardingCompleted),
      metadata: (u as any).metadata ?? null,
    },
    memberships: items,
  });
}

/**
 * `DELETE /api/admin/data/users/:userId` — staff disable an account.
 *
 * Disabling has to take away *every* way in, not just the browser.
 *
 * This used to be a single `$set: { isActive: false }`. That ends the web session on the next
 * request — `isAccountDisabled` in the actor gate reads this row — but an `lnk_` API key is not a
 * session: `verifyBearerToken` asks whether the key is revoked and whether its owner is still a
 * member of the workspace, and never whether the human behind it still has an account. Memberships
 * are untouched by a disable, so every key that person had ever minted kept full read/write on
 * every workspace they belonged to, for ever — nothing expires a key. Staff shutting down a
 * compromised or abusive account were closing the front door and leaving the automation running.
 *
 * So the keys are revoked here, the way self-service deletion already does it
 * (`src/app/api/account/delete/route.ts`). Revocation rather than a new check inside
 * `verifyBearerToken` is deliberate: `revokedAt` is read from the database on every single agent
 * request with no cache in front of it, so it takes effect immediately and on every instance,
 * whereas an "is the owner active" check would have to be cached to stay off the hot path and would
 * then lag by its TTL on every instance but this one.
 *
 * Order matters. Keys first, account second: if the second write fails, the residue is "keys dead,
 * account still active" — visible, recoverable, and not a hole. The other order leaves a disabled
 * account whose automation still works, which is exactly the bug being fixed.
 */
export async function DELETE(request: Request, ctx: { params: Promise<{ userId: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { userId: userIdRaw } = await ctx.params;
  const userId = (userIdRaw ?? "").trim();
  if (!Types.ObjectId.isValid(userId)) return NextResponse.json({ error: "Invalid userId" }, { status: 400 });

  await connectMongo();
  const userObjectId = new Types.ObjectId(userId);
  const disabledAt = new Date();

  const keys = await ApiKeyModel.updateMany(
    { createdByUserId: userObjectId, revokedAt: null, isDeleted: { $ne: true } },
    { $set: { revokedAt: disabledAt } },
  );

  const res = await UserModel.updateOne({ _id: userObjectId }, { $set: { isActive: false } });
  if (!res.matchedCount) return NextResponse.json({ error: "User not found" }, { status: 404 });

  // Drop the cached "is this account disabled" answer so the web session ends on the very next
  // request instead of up to the cache's TTL later. Self-service deletion does the same.
  accountDisabledChanged(userId);

  // Reported so the staff page can say what the disable actually took away.
  const revokedApiKeys = typeof keys?.modifiedCount === "number" ? keys.modifiedCount : 0;
  return NextResponse.json({ ok: true, userId, isActive: false, revokedApiKeys });
}


