/**
 * API route for `/api/credits/purchase` — prepaid credit packs.
 *
 * - `POST { packId }` (Free and annual-Pro workspaces; 409 on monthly Pro, which uses on-demand) starts a one-time Stripe Checkout for one pack (`src/lib/credits/packs.ts`)
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
import { recordActivity } from "@/lib/activity/log";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { UserModel } from "@/lib/models/User";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { creditPacksAllowed } from "@/lib/billing/subscriptionState";
import { CreditPurchaseModel } from "@/lib/models/CreditPurchase";
import { ensureWorkspaceStripeCustomer } from "@/lib/billing/workspaceCustomer";
import { CREDIT_PACK_CURRENCY, PURCHASED_CREDITS_EXPIRY_MONTHS, findPurchasablePack } from "@/lib/credits/packs";
import { forbidWaitlisted } from "@/lib/gating/waitlist";
import { forbidApiKey } from "@/lib/gating/forbidApiKey";
import { requireOrgRole } from "@/lib/orgs/requireOrgRole";

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
      /**
       * The two guards every sibling money route has, and this one did not.
       *
       * `/api/stripe/checkout`, `/api/stripe/portal` and `/api/billing/spend` all call
       * `forbidApiKey` and check the org role. This route checked neither, and an `lnk_` API key
       * resolves to a `kind: "user"` actor — so an agent could POST a packId and get back a live
       * Stripe Checkout URL for a $39 charge bound to the workspace's own customer, and a `viewer`
       * could do the same from the browser. Committing somebody else's workspace to a charge is
       * exactly what the role check on the subscription route exists to prevent; a one-off pack is
       * the same act for less money.
       */
      const keyForbidden = forbidApiKey(actor, "buy credits");
      if (keyForbidden) return keyForbidden;

      // Same rule as the subscription checkout: credits buy AI runs, and a queued account cannot
      // reach an AI run. Refused before the pack is resolved, so nothing about the catalogue or the
      // price is disclosed to someone who may not buy.
      const queued = await forbidWaitlisted(actor, "buy credits", { reason: "credits" });
      if (queued) return queued;

      const role = await requireOrgRole({ orgId: actor.orgId, userId: actor.userId, minRole: "admin" });
      if (!role.ok) {
        return NextResponse.json(
          { error: "Only an owner or admin can buy credits for this workspace." },
          { status: 403 },
        );
      }

      const body = (await request.json().catch(() => null)) as { packId?: unknown } | null;
      // Purchasable only: a retired id still resolves for *recording* an in-flight purchase
      // (see `RETIRED_CREDIT_PACKS`), but must never open a Checkout at a withdrawn price.
      const pack = findPurchasablePack(body?.packId);
      if (!pack) return NextResponse.json({ error: "Unknown credit pack" }, { status: 400 });

      const stripeKey = (process.env.STRIPE_SECRET_KEY ?? "").trim();
      if (!stripeKey) return NextResponse.json({ error: "Payments are not configured for this deployment." }, { status: 400 });
      const stripe = new Stripe(stripeKey);

      await connectMongo();
      const userId = new Types.ObjectId(actor.userId);
      const orgId = new Types.ObjectId(actor.orgId);
      // Packs are how Free adds credits. Monthly Pro keeps going past its monthly credits with
      // on-demand usage at a lower per-credit price, so selling it a pricier pack would only cost it
      // more. Annual Pro has no on-demand (its yearly subscription cannot carry the monthly metered
      // price), so packs are its way past the monthly credits and it may buy them.
      const sub = await SubscriptionModel.findOne({ orgId, isDeleted: { $ne: true } }).select({ status: 1, kind: 1, interval: 1 }).lean();
      if (!creditPacksAllowed(sub as { status?: unknown; kind?: unknown; interval?: unknown } | null)) {
        return NextResponse.json(
          {
            error: "Credit packs are for Free workspaces. On Pro, turn on on-demand usage in Limits to keep going past your monthly credits.",
            code: "PACKS_FREE_ONLY",
          },
          { status: 409 },
        );
      }
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
      // The funnel's pack branch; the webhook grants the credits when this one completes.
      void recordActivity({
        orgId,
        userId,
        actorKind: actor.kind,
        type: "checkout.started",
        meta: { kind: "credit_pack", pack: pack.id, credits: pack.credits, priceCents: pack.priceCents },
        request,
      });
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
