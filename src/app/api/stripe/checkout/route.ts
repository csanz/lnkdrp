/**
 * API route for `/api/stripe/checkout` — creates a Stripe Checkout Session for a subscription.
 *
 * Security:
 * - Requires an authenticated user.
 * - Returns only a Stripe-hosted URL; does not grant access (webhook-only).
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import Stripe from "stripe";

import { connectMongo } from "@/lib/mongodb";
import { resolveActor } from "@/lib/gating/actor";
import { UserModel } from "@/lib/models/User";

export const runtime = "nodejs";

function mustGetEnv(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function appUrlFromRequest(request: Request): string {
  // Prefer configured canonical URL (used for Stripe redirect URLs).
  const configured = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  // Fallback: derive from request origin (dev-friendly).
  return new URL(request.url).origin;
}

export async function POST(request: Request) {
  const actor = await resolveActor(request);
  try {
    if (actor.kind !== "user") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!Types.ObjectId.isValid(actor.userId)) {
      return NextResponse.json({ error: "Invalid user" }, { status: 400 });
    }

    const stripeKey = mustGetEnv("STRIPE_SECRET_KEY");
    const priceId = mustGetEnv("STRIPE_PRICE_ID");
    const stripe = new Stripe(stripeKey);

    await connectMongo();
    const userId = new Types.ObjectId(actor.userId);
    const user = await UserModel.findOne({ _id: userId })
      .select({ _id: 1, email: 1, stripeCustomerId: 1 })
      .lean();
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    let customerId = typeof (user as any)?.stripeCustomerId === "string" ? String((user as any).stripeCustomerId).trim() : "";
    if (!customerId) {
      const email = typeof (user as any)?.email === "string" ? String((user as any).email).trim() : "";
      const customer = await stripe.customers.create({
        email: email || undefined,
        metadata: { userId: String(userId) },
      });
      customerId = customer.id;
      await UserModel.updateOne({ _id: userId }, { $set: { stripeCustomerId: customerId } });
    }

    const appUrl = appUrlFromRequest(request);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/billing/cancel`,
      client_reference_id: String(userId),
      allow_promotion_codes: true,
      metadata: { userId: String(userId) },
      // Helpful for correlating subscription webhooks back to this user.
      subscription_data: { metadata: { userId: String(userId) } },
    });

    const url = typeof session?.url === "string" ? session.url : "";
    if (!url) throw new Error("Failed to create Checkout Session");

    return NextResponse.json({ url });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


