/**
 * API route for `/api/billing/status` — returns current user's billing state.
 *
 * Workspace-bound: this returns the current **active org/workspace** subscription state.
 *
 * This is used by the `/billing/success` page to poll until Stripe webhooks have updated MongoDB.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { resolveActor } from "@/lib/gating/actor";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { OrgModel } from "@/lib/models/Org";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const actor = await resolveActor(request);
  try {
    if (actor.kind !== "user") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!Types.ObjectId.isValid(actor.orgId)) return NextResponse.json({ error: "Invalid org" }, { status: 400 });

    await connectMongo();
    const orgId = new Types.ObjectId(actor.orgId);
    const org = await OrgModel.findOne({ _id: orgId, isDeleted: { $ne: true } })
      .select({ name: 1, avatarUrl: 1 })
      .lean();
    const orgName = typeof (org as any)?.name === "string" ? String((org as any).name).trim() : "";
    const orgAvatarUrl =
      typeof (org as any)?.avatarUrl === "string" ? String((org as any).avatarUrl).trim() : "";

    const sub = await SubscriptionModel.findOne({ orgId, isDeleted: { $ne: true } })
      .select({ status: 1, currentPeriodEnd: 1, cancelAtPeriodEnd: 1 })
      .lean();

    const statusRaw = typeof (sub as any)?.status === "string" ? String((sub as any).status).trim() : "";
    const stripeSubscriptionStatus = statusRaw || "free";
    const plan = stripeSubscriptionStatus === "active" || stripeSubscriptionStatus === "trialing" ? "pro" : "free";
    const stripeCurrentPeriodEnd =
      (sub as any)?.currentPeriodEnd ? new Date((sub as any).currentPeriodEnd).toISOString() : null;

    return NextResponse.json({
      org: { id: String(orgId), name: orgName || null, avatarUrl: orgAvatarUrl || null },
      plan,
      stripeSubscriptionStatus: stripeSubscriptionStatus || null,
      stripeCurrentPeriodEnd,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


