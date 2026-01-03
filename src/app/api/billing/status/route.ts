/**
 * API route for `/api/billing/status` — returns current user's billing state.
 *
 * This is used by the `/billing/success` page to poll until Stripe webhooks have updated MongoDB.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { resolveActor } from "@/lib/gating/actor";
import { UserModel } from "@/lib/models/User";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const actor = await resolveActor(request);
  try {
    if (actor.kind !== "user") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!Types.ObjectId.isValid(actor.userId)) {
      return NextResponse.json({ error: "Invalid user" }, { status: 400 });
    }

    await connectMongo();
    const userId = new Types.ObjectId(actor.userId);
    const user = await UserModel.findOne({ _id: userId })
      .select({ plan: 1, stripeSubscriptionStatus: 1, stripeCurrentPeriodEnd: 1 })
      .lean();
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const plan = (typeof (user as any)?.plan === "string" ? String((user as any).plan).trim() : "free") || "free";
    const stripeSubscriptionStatus =
      typeof (user as any)?.stripeSubscriptionStatus === "string"
        ? String((user as any).stripeSubscriptionStatus).trim()
        : null;
    const stripeCurrentPeriodEnd =
      (user as any)?.stripeCurrentPeriodEnd instanceof Date
        ? (user as any).stripeCurrentPeriodEnd.toISOString()
        : (user as any)?.stripeCurrentPeriodEnd
          ? new Date((user as any).stripeCurrentPeriodEnd).toISOString()
          : null;

    return NextResponse.json({
      plan,
      stripeSubscriptionStatus: stripeSubscriptionStatus || null,
      stripeCurrentPeriodEnd,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


