/**
 * API route for `/api/credits/purchase` — prepaid credit packs.
 *
 * - `POST { packId }` starts a one-time Stripe Checkout for one pack (`src/lib/credits/packs.ts`)
 *   and returns `{ url }`. The price is sent inline from the pack list, so no Stripe catalog entry
 *   or env var backs it. Credits are granted by the Stripe webhook once payment is confirmed, never
 *   by the redirect back.
 * - `GET ?session_id=` reports whether that Checkout's credits have landed, for the page the buyer
 *   returns to. Scoped to the caller's own workspace.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import Stripe from "stripe";

import { connectMongo } from "@/lib/mongodb";
import { resolveActor } from "@/lib/gating/actor";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { UserModel } from "@/lib/models/User";
import { CreditPurchaseModel } from "@/lib/models/CreditPurchase";
import { ensureWorkspaceStripeCustomer } from "@/lib/billing/workspaceCustomer";
import { CREDIT_PACK_CURRENCY, PURCHASED_CREDITS_EXPIRY_MONTHS, findCreditPack } from "@/lib/credits/packs";

export const runtime = "nodejs";

function appUrlFromRequest(request: Request): string {
  const configured = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  return new URL(request.url).origin;
}

export async function POST(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActor(request);
    try {
      if (actor.kind !== "user") return NextResponse.json({ error: "Sign in to buy credits." }, { status: 401 });
      if (!Types.ObjectId.isValid(actor.userId) || !Types.ObjectId.isValid(actor.orgId)) {
        return NextResponse.json({ error: "Invalid workspace" }, { status: 400 });
      }
      const body = (await request.json().catch(() => null)) as { packId?: unknown } | null;
      const pack = findCreditPack(body?.packId);
      if (!pack) return NextResponse.json({ error: "Unknown credit pack" }, { status: 400 });

      const stripeKey = (process.env.STRIPE_SECRET_KEY ?? "").trim();
      if (!stripeKey) return NextResponse.json({ error: "Payments are not configured for this deployment." }, { status: 400 });
      const stripe = new Stripe(stripeKey);

      await connectMongo();
      const userId = new Types.ObjectId(actor.userId);
      const orgId = new Types.ObjectId(actor.orgId);
      const user = (await UserModel.findOne({ _id: userId }).select({ email: 1 }).lean()) as { email?: string } | null;
      if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

      // Same Stripe customer as the workspace's subscription, so every payment sits under one
      // customer in Stripe and the portal shows them together.
      const { customerId, workspaceName } = await ensureWorkspaceStripeCustomer({ stripe, orgId, userId, email: user.email });

      const appUrl = appUrlFromRequest(request);
      // `priceCents` records what this Checkout charges, so a price change deployed while someone is
      // mid-checkout doesn't make their completed payment fail the webhook's amount check.
      const metadata = {
        kind: "credit_pack",
        orgId: String(orgId),
        userId: String(userId),
        packId: pack.id,
        credits: String(pack.credits),
        priceCents: String(pack.priceCents),
      };
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer: customerId,
        client_reference_id: String(orgId),
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: CREDIT_PACK_CURRENCY,
              unit_amount: pack.priceCents,
              product_data: {
                name: `${pack.credits} AI credits`,
                description: `LinkDrop AI credits for ${workspaceName}. Unused credits expire ${PURCHASED_CREDITS_EXPIRY_MONTHS} months after purchase.`,
              },
            },
          },
        ],
        metadata,
        payment_intent_data: { metadata },
        success_url: `${appUrl}/credits?purchase=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${appUrl}/credits?purchase=canceled`,
      });
      if (!session.url) throw new Error("Failed to create Checkout Session");
      return NextResponse.json({ url: session.url });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 400 });
    }
  });
}

export async function GET(request: Request) {
  const actor = await resolveActor(request);
  if (actor.kind !== "user" || !Types.ObjectId.isValid(actor.orgId)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const sessionId = (new URL(request.url).searchParams.get("session_id") ?? "").trim();
  if (!sessionId) return NextResponse.json({ error: "Missing session_id" }, { status: 400 });
  await connectMongo();
  const purchase = (await CreditPurchaseModel.findOne({ stripeCheckoutSessionId: sessionId, orgId: new Types.ObjectId(actor.orgId) })
    .select({ credits: 1, expiresAt: 1 })
    .lean()) as { credits: number; expiresAt: Date } | null;
  return NextResponse.json(
    purchase ? { status: "granted", credits: purchase.credits, expiresAt: purchase.expiresAt.toISOString() } : { status: "pending" },
    { headers: { "cache-control": "no-store" } },
  );
}
