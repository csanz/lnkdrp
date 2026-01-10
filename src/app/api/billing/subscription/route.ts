/**
 * API route for `/api/billing/subscription` — returns current org subscription status for the dashboard.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { resolveActor, tryResolveUserActorFast } from "@/lib/gating/actor";
import { SubscriptionModel } from "@/lib/models/Subscription";

export const runtime = "nodejs";

export async function GET(request: Request) {
  // Hot path (dashboard): prefer fast resolver (cookie/JWT + single membership check).
  const actor = (await tryResolveUserActorFast(request)) ?? (await resolveActor(request));
  try {
    if (actor.kind !== "user") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!Types.ObjectId.isValid(actor.orgId)) {
      return NextResponse.json({ error: "Invalid org" }, { status: 400 });
    }
    const orgId = new Types.ObjectId(actor.orgId);

    await connectMongo();

    const sub = await SubscriptionModel.findOne({ orgId, isDeleted: { $ne: true } })
      .select({
        status: 1,
        planName: 1,
        currentPeriodEnd: 1,
        cancelAtPeriodEnd: 1,
        stripeCustomerId: 1,
      })
      .lean();

    const statusRaw = typeof (sub as any)?.status === "string" ? String((sub as any).status).trim() : "";
    const status = statusRaw || "free";

    const planNameRaw = typeof (sub as any)?.planName === "string" ? String((sub as any).planName).trim() : "";
    const planName = planNameRaw || (status === "free" ? "Free" : "Paid");

    const checkoutUrl = "https://buy.stripe.com/test_3cI3cueBb4xA7zxfPk7g400";

    return NextResponse.json({
      ok: true,
      subscription: {
        status,
        planName,
        currentPeriodEnd: (sub as any)?.currentPeriodEnd ? new Date((sub as any).currentPeriodEnd).toISOString() : null,
        cancelAtPeriodEnd: Boolean((sub as any)?.cancelAtPeriodEnd),
        canManage: Boolean((sub as any)?.stripeCustomerId),
      },
      checkoutUrl,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


