/**
 * API route for `/api/stripe/portal` — creates a Stripe billing portal session URL.
 *
 * Security:
 * - Requires an authenticated user.
 * - Workspace-bound: uses the active org's `Subscription.stripeCustomerId`; does not trust client input.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import Stripe from "stripe";

import { connectMongo } from "@/lib/mongodb";
import { resolveActor } from "@/lib/gating/actor";
import { SubscriptionModel } from "@/lib/models/Subscription";

export const runtime = "nodejs";

function mustGetEnv(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function appUrlFromRequest(request: Request): string {
  const configured = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  return new URL(request.url).origin;
}

export async function POST(request: Request) {
  const actor = await resolveActor(request);
  try {
    if (actor.kind !== "user") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!Types.ObjectId.isValid(actor.orgId)) return NextResponse.json({ error: "Invalid org" }, { status: 400 });

    const stripeKey = mustGetEnv("STRIPE_SECRET_KEY");
    const stripe = new Stripe(stripeKey);
    const orgId = new Types.ObjectId(actor.orgId);

    await connectMongo();
    const sub = await SubscriptionModel.findOne({ orgId, isDeleted: { $ne: true } })
      .select({ stripeCustomerId: 1 })
      .lean();
    const customerId =
      typeof (sub as any)?.stripeCustomerId === "string" ? String((sub as any).stripeCustomerId).trim() : "";
    if (!customerId) {
      return NextResponse.json({ error: "No Stripe customer found for this workspace." }, { status: 400 });
    }

    const appUrl = appUrlFromRequest(request);
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${appUrl}/dashboard?tab=overview`,
    });
    const url = typeof portal?.url === "string" ? portal.url : "";
    if (!url) throw new Error("Failed to create billing portal session");

    return NextResponse.json({ url });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


