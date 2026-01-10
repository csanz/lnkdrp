/**
 * API route for `/api/billing/subscription/manage` — creates a Stripe customer portal session URL.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import Stripe from "stripe";
import { connectMongo } from "@/lib/mongodb";
import { resolveActor, tryResolveUserActorFast } from "@/lib/gating/actor";
import { SubscriptionModel } from "@/lib/models/Subscription";

export const runtime = "nodejs";

export async function POST(request: Request) {
  // Hot path (dashboard): prefer fast resolver (cookie/JWT + single membership check).
  const actor = (await tryResolveUserActorFast(request)) ?? (await resolveActor(request));
  try {
    if (actor.kind !== "user") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!Types.ObjectId.isValid(actor.orgId)) {
      return NextResponse.json({ error: "Invalid org" }, { status: 400 });
    }
    const stripeKey = (process.env.STRIPE_SECRET_KEY ?? "").trim();
    if (!stripeKey) {
      return NextResponse.json({ error: "Stripe is not configured." }, { status: 500 });
    }

    await connectMongo();
    const orgId = new Types.ObjectId(actor.orgId);
    const sub = await SubscriptionModel.findOne({ orgId, isDeleted: { $ne: true } })
      .select({ stripeCustomerId: 1 })
      .lean();
    const customer = typeof (sub as any)?.stripeCustomerId === "string" ? String((sub as any).stripeCustomerId).trim() : "";
    if (!customer) {
      return NextResponse.json({ error: "No subscription customer found." }, { status: 400 });
    }

    const stripe = new Stripe(stripeKey);
    const origin = new URL(request.url).origin;
    const portal = await stripe.billingPortal.sessions.create({
      customer,
      return_url: `${origin}/dashboard?tab=overview`,
    });
    const url = typeof portal?.url === "string" ? portal.url : "";
    if (!url) throw new Error("Failed to create portal session");

    return NextResponse.json({ ok: true, url });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


