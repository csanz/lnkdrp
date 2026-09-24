/**
 * `POST /api/account/delete` — the person asks for their account to be deleted.
 *
 * This is the immediate, reversible half: the account stops working now, the data goes 30 days
 * later (`/api/cron/account-purge`). Everything here is scoped to the caller's own account; an
 * admin deactivating someone else is a different route.
 *
 * What "stops working" means, in one transaction's worth of writes:
 * - the user row is disabled and stamped with the request, its reason and the purge date;
 * - every API key they own is revoked, so no agent keeps acting as them;
 * - every share link in a workspace they own alone stops resolving, so recipients cannot keep
 *   reading documents whose owner has left;
 * - live sessions end at the next request (`isAccountDisabled` in the actor gate).
 *
 * Workspaces with other members are left alone: one person leaving must not delete a team's
 * documents. Their membership is removed and the workspace carries on.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { resolveExistingActor, accountDisabledChanged } from "@/lib/gating/actor";
import { UserModel } from "@/lib/models/User";
import { ApiKeyModel } from "@/lib/models/ApiKey";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { ShareLinkModel } from "@/lib/models/ShareLink";
import { DocModel } from "@/lib/models/Doc";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { isOpenStatus } from "@/lib/billing/subscriptionState";
import { scheduleStripeCancelAtPeriodEnd } from "@/lib/billing/stripeSubscriptionCancel";
import { logErrorEvent } from "@/lib/errors/logger";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { recordActivity } from "@/lib/activity/log";
import { parseDeletionRequest, purgeAfter } from "@/lib/accounts/deletion";
import { forbidApiKey } from "@/lib/gating/forbidApiKey";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveExistingActor(request);
    // Identity-grade: a key may not delete an account — see forbidApiKey.
    const keyRefusal = actor ? forbidApiKey(actor, "delete an account") : null;
    if (keyRefusal) return keyRefusal;
    if (!actor || actor.kind !== "user") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const parsed = parseDeletionRequest(body ?? {});
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    await connectMongo();
    const userId = new Types.ObjectId(actor.userId);
    const user = (await UserModel.findOne({ _id: userId }).select({ email: 1, deletionRequestedAt: 1 }).lean()) as
      | { email?: string; deletionRequestedAt?: Date | null }
      | null;
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (user.deletionRequestedAt) {
      return NextResponse.json({ error: "This account is already scheduled for deletion." }, { status: 409 });
    }

    const requestedAt = new Date();
    const purgeAt = purgeAfter(requestedAt);

    // Workspaces this person owns alone: nobody else can take them over, so their links stop here.
    // Workspaces they own with others but where no other owner or admin exists: the members stay,
    // but nobody left can manage billing, so the subscription must not keep charging this card.
    const memberships = (await OrgMembershipModel.find({ userId, isDeleted: { $ne: true } })
      .select({ orgId: 1, role: 1 })
      .limit(500)
      .lean()) as Array<{ orgId: Types.ObjectId; role?: string }>;
    const ownedOrgIds: Types.ObjectId[] = [];
    const billingOrphanOrgIds: Types.ObjectId[] = [];
    // Owned with another owner/admin present: billing stays with the workspace, but the card on
    // the Stripe customer is the leaver's, so the people who remain are told to replace it.
    const otherAdminsByOrg = new Map<string, number>();
    for (const m of memberships) {
      if (m.role !== "owner") continue;
      const [others, otherAdmins] = await Promise.all([
        OrgMembershipModel.countDocuments({ orgId: m.orgId, userId: { $ne: userId }, isDeleted: { $ne: true } }),
        OrgMembershipModel.countDocuments({
          orgId: m.orgId,
          userId: { $ne: userId },
          role: { $in: ["owner", "admin"] },
          isDeleted: { $ne: true },
        }),
      ]);
      if (others === 0) ownedOrgIds.push(m.orgId);
      else if (otherAdmins === 0) billingOrphanOrgIds.push(m.orgId);
      else otherAdminsByOrg.set(String(m.orgId), otherAdmins);
    }

    /**
     * Stop the subscriptions this person's card pays for, before anything is disabled.
     *
     * The request used to touch keys, links and documents and never Stripe. The purge cancels
     * solo workspaces' subscriptions, but thirty days later, so a solo Pro workspace was billed
     * once more during the grace; and the purge leaves shared workspaces alone entirely, so a
     * team whose only owner left kept charging the departed owner's card with nobody able to open
     * the portal. Cancelling at period end keeps what is already paid for working and is reversible
     * from the portal until then. A Stripe failure refuses the whole request: an account that still
     * exists can try again; an orphaned subscription cannot.
     */
    const subscriptionOrgIds = [...ownedOrgIds, ...billingOrphanOrgIds, ...[...otherAdminsByOrg.keys()].map((id) => new Types.ObjectId(id))];
    const subs = subscriptionOrgIds.length
      ? ((await SubscriptionModel.find({
          orgId: { $in: subscriptionOrgIds },
          isDeleted: { $ne: true },
          stripeSubscriptionId: { $nin: [null, ""] },
        })
          .select({ orgId: 1, stripeSubscriptionId: 1, status: 1, currentPeriodEnd: 1 })
          .lean()) as Array<{ orgId: Types.ObjectId; stripeSubscriptionId?: string | null; status?: string; currentPeriodEnd?: Date | null }>)
      : [];
    const openSubs = subs.filter((s) => isOpenStatus(s.status));
    // Stop the ones nobody else could manage; only notify where another owner/admin remains.
    const liveSubs = openSubs.filter((s) => !otherAdminsByOrg.has(String(s.orgId)));
    const handoverSubs = openSubs.filter((s) => otherAdminsByOrg.has(String(s.orgId)));
    for (const s of liveSubs) {
      const outcome = await scheduleStripeCancelAtPeriodEnd(String(s.stripeSubscriptionId));
      if (!outcome.ok) {
        await logErrorEvent({
          severity: "error",
          category: "stripe",
          code: "STRIPE_CANCEL_FAILED",
          message: outcome.error,
          request,
          route: "/api/account/delete",
          method: "POST",
          statusCode: 502,
          ids: { workspaceId: String(s.orgId), userId: actor.userId },
        });
        return NextResponse.json(
          {
            error: "A subscription your account pays for could not be stopped, so the deletion was not started. Try again in a moment, or contact support.",
            code: "STRIPE_CANCEL_FAILED",
          },
          { status: 502 },
        );
      }
    }
    if (liveSubs.length) {
      await SubscriptionModel.updateMany(
        { _id: { $in: liveSubs.map((s) => (s as { _id?: Types.ObjectId })._id).filter(Boolean) } },
        { $set: { cancelAtPeriodEnd: true } },
      );
    }

    // Documents that predate `orgId` (the purge uses the same shape) are owned by this user
    // directly and sit in no workspace; `resolveShareLink` would otherwise mint a default link
    // for them from `shareEnabled` after every explicit link row was disabled.
    const legacyOwned = { userId, $or: [{ orgId: { $exists: false } }, { orgId: null }] };
    const ownedScope = ownedOrgIds.length ? { $or: [{ orgId: { $in: ownedOrgIds } }, legacyOwned] } : legacyOwned;

    const [keys, links, docs] = await Promise.all([
      ApiKeyModel.updateMany({ createdByUserId: userId, revokedAt: null, isDeleted: { $ne: true } }, { $set: { revokedAt: requestedAt } }),
      ShareLinkModel.updateMany({ ...ownedScope, enabled: { $ne: false } }, { $set: { enabled: false } }),
      // `shareEnabled` is the field; this wrote `isShared`, which no schema has, so the count was
      // always 0 and every document stayed shareable through the default-link fallback.
      DocModel.updateMany({ ...ownedScope, shareEnabled: true }, { $set: { shareEnabled: false } }),
    ]);

    await UserModel.updateOne(
      { _id: userId },
      {
        $set: {
          isActive: false,
          deletionRequestedAt: requestedAt,
          deletionReasonCode: parsed.value.reasonCode,
          deletionReasonText: parsed.value.reasonText,
          deletionPurgeAfter: purgeAt,
          deletionPurgedAt: null,
        },
      },
    );
    accountDisabledChanged(actor.userId);

    // One activity row per owned workspace, so a workspace that goes quiet says why.
    for (const orgId of ownedOrgIds) {
      void recordActivity({
        orgId: String(orgId),
        userId: actor.userId,
        actorKind: "user",
        type: "account.deletion_requested",
        title: user.email ?? "Account",
        meta: { purgeAfter: purgeAt.toISOString(), reasonCode: parsed.value.reasonCode },
        request,
      });
    }
    // And one per workspace whose Pro is ending, so the members who stay learn why before it does;
    // where another owner/admin remains the row says to replace the card instead.
    for (const s of [...liveSubs, ...handoverSubs]) {
      void recordActivity({
        orgId: String(s.orgId),
        userId: actor.userId,
        actorKind: "user",
        type: "plan.subscription_ending",
        title: user.email ?? "Account",
        meta: {
          periodEnd: s.currentPeriodEnd ? new Date(s.currentPeriodEnd).toISOString() : null,
          otherAdmins: otherAdminsByOrg.get(String(s.orgId)) ?? 0,
        },
        request,
      });
    }

    return NextResponse.json({
      ok: true,
      deletionRequestedAt: requestedAt.toISOString(),
      purgeAfter: purgeAt.toISOString(),
      disabled: {
        apiKeysRevoked: (keys as { modifiedCount?: number }).modifiedCount ?? 0,
        shareLinksDisabled: (links as { modifiedCount?: number }).modifiedCount ?? 0,
        docsUnshared: (docs as { modifiedCount?: number }).modifiedCount ?? 0,
        workspacesClosed: ownedOrgIds.length,
        subscriptionsEnding: liveSubs.length,
      },
    });
  });
}
