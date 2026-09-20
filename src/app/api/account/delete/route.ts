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
    const memberships = (await OrgMembershipModel.find({ userId, isDeleted: { $ne: true } })
      .select({ orgId: 1, role: 1 })
      .limit(500)
      .lean()) as Array<{ orgId: Types.ObjectId; role?: string }>;
    const ownedOrgIds: Types.ObjectId[] = [];
    for (const m of memberships) {
      if (m.role !== "owner") continue;
      const others = await OrgMembershipModel.countDocuments({
        orgId: m.orgId,
        userId: { $ne: userId },
        isDeleted: { $ne: true },
      });
      if (others === 0) ownedOrgIds.push(m.orgId);
    }

    const [keys, links, docs] = await Promise.all([
      ApiKeyModel.updateMany({ createdByUserId: userId, revokedAt: null, isDeleted: { $ne: true } }, { $set: { revokedAt: requestedAt } }),
      ownedOrgIds.length
        ? ShareLinkModel.updateMany({ orgId: { $in: ownedOrgIds }, enabled: { $ne: false } }, { $set: { enabled: false } })
        : Promise.resolve({ modifiedCount: 0 }),
      ownedOrgIds.length
        ? DocModel.updateMany({ orgId: { $in: ownedOrgIds }, isShared: true }, { $set: { isShared: false } })
        : Promise.resolve({ modifiedCount: 0 }),
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

    return NextResponse.json({
      ok: true,
      deletionRequestedAt: requestedAt.toISOString(),
      purgeAfter: purgeAt.toISOString(),
      disabled: {
        apiKeysRevoked: (keys as { modifiedCount?: number }).modifiedCount ?? 0,
        shareLinksDisabled: (links as { modifiedCount?: number }).modifiedCount ?? 0,
        docsUnshared: (docs as { modifiedCount?: number }).modifiedCount ?? 0,
        workspacesClosed: ownedOrgIds.length,
      },
    });
  });
}
