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
import { SubscriptionModel } from "@/lib/models/Subscription";

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

function checkoutRedirects(request: Request): { successUrl: string; cancelUrl: string } {
  // Optional explicit overrides (useful when running behind a proxy / multiple environments).
  const successOverride = (process.env.STRIPE_SUCCESS_URL ?? "").trim();
  const cancelOverride = (process.env.STRIPE_CANCEL_URL ?? "").trim();
  if (successOverride && cancelOverride) {
    return { successUrl: successOverride, cancelUrl: cancelOverride };
  }

  const appUrl = appUrlFromRequest(request);
  return {
    successUrl: `${appUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${appUrl}/billing/cancel`,
  };
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
    if (!Types.ObjectId.isValid(actor.orgId)) {
      return NextResponse.json({ error: "Invalid org" }, { status: 400 });
    }

    const stripeKey = mustGetEnv("STRIPE_SECRET_KEY");
    const priceId = mustGetEnv("STRIPE_PRICE_ID");
    const stripe = new Stripe(stripeKey);

    await connectMongo();
    const userId = new Types.ObjectId(actor.userId);
    const orgId = new Types.ObjectId(actor.orgId);
    const user = await UserModel.findOne({ _id: userId })
      .select({ _id: 1, email: 1 })
      .lean();
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    // Workspace-bound billing: one Stripe customer per org/workspace (SubscriptionModel is per-org).
    const existingSub = await SubscriptionModel.findOne({ orgId, isDeleted: { $ne: true } })
      .select({ _id: 1, stripeCustomerId: 1 })
      .lean();

    let customerId =
      typeof (existingSub as any)?.stripeCustomerId === "string" ? String((existingSub as any).stripeCustomerId).trim() : "";
    if (!customerId) {
      const email = typeof (user as any)?.email === "string" ? String((user as any).email).trim() : "";
      const customer = await stripe.customers.create({
        email: email || undefined,
        metadata: { userId: String(userId), orgId: String(orgId) },
      });
      customerId = customer.id;

      // Upsert the org subscription pointer row.
      await SubscriptionModel.updateOne(
        { orgId },
        {
          $setOnInsert: { orgId, isDeleted: false },
          $set: { stripeCustomerId: customerId },
        },
        { upsert: true },
      );
    }

    const { successUrl, cancelUrl } = checkoutRedirects(request);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      // Use orgId here so Checkout completion can be mapped even if metadata is missing.
      client_reference_id: String(orgId),
      allow_promotion_codes: true,
      // Include BOTH userId and orgId so webhooks can update the correct workspace.
      metadata: { userId: String(userId), orgId: String(orgId) },
      // Helpful for correlating subscription webhooks back to this user.
      subscription_data: { metadata: { userId: String(userId), orgId: String(orgId) } },
    });

    const url = typeof session?.url === "string" ? session.url : "";
    if (!url) throw new Error("Failed to create Checkout Session");

    return NextResponse.json({ url });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


