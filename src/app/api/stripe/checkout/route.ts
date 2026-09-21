/**
 * API route for `/api/stripe/checkout` — creates a Stripe Checkout Session for a subscription.
 *
 * Security:
 * - Requires an authenticated user.
 * - Returns only a Stripe-hosted URL; does not grant access (webhook-only).
 * - Refuses (409) when the workspace already has a billable subscription of either kind; the
 *   client should send the user to the billing portal (`POST /api/stripe/portal`) instead.
 *
 * Body: `{ plan?: "pro" }`, default `"pro"`. `"payg"` is refused (400): pay-as-you-go for Free
 * was retired on 2026-09-17. On-demand usage is Pro's overage, and Free workspaces buy credit packs
 * (`/api/credits/purchase`) instead, so paying per credit is never cheaper off Pro. The webhook
 * still understands existing `payg` subscriptions.
 *
 * Line items: `STRIPE_PRICE_ID` (recurring Pro plan, quantity 1), plus `STRIPE_AI_CREDITS_PRICE_ID`
 * (metered AI credits for on-demand; no quantity — metered prices reject it) when configured.
 *
 * The session carries `metadata.kind` so the webhook knows which one this was even before it can
 * inspect the subscription's own items (`subscriptionKindFromPriceIds` in
 * `src/lib/billing/subscriptionState.ts` prefers the items; this is the fallback).
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import Stripe from "stripe";

import { connectMongo } from "@/lib/mongodb";
import { resolveActor } from "@/lib/gating/actor";
import { UserModel } from "@/lib/models/User";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { getAiCreditsPriceId } from "@/lib/credits/stripeReporting";
import { isBillableSubscription } from "@/lib/billing/subscriptionState";
import { ensureWorkspaceStripeCustomer } from "@/lib/billing/workspaceCustomer";
import { forbidApiKey } from "@/lib/gating/forbidApiKey";
import { requireOrgRole } from "@/lib/orgs/requireOrgRole";

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
  return withMongoRequestLogging(request, async () => {
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

      /**
       * Starting a subscription is a billing action, like managing or cancelling one.
       *
       * The role rule was applied to the portal, the manage route and invoices and stopped at this
       * sibling, which is the one that actually commits the workspace to a charge: any member —
       * a viewer included — could open Checkout and put the owner's workspace on a paid plan.
       */
      const keyForbidden = forbidApiKey(actor, "start a subscription");
      if (keyForbidden) return keyForbidden;
      const role = await requireOrgRole({ orgId: actor.orgId, userId: actor.userId, minRole: "admin" });
      if (!role.ok) {
        return NextResponse.json(
          { error: "Only an owner or admin can start a subscription for this workspace." },
          { status: 403 },
        );
      }

      const body = (await request.json().catch(() => null)) as { plan?: unknown } | null;
      if (body?.plan === "payg") {
        return NextResponse.json(
          {
            error: "Pay-as-you-go is no longer offered. Buy a credit pack at /credits, or upgrade to Pro for on-demand usage.",
            code: "PAYG_RETIRED",
          },
          { status: 400 },
        );
      }
      const plan = "pro" as const;

      const stripeKey = mustGetEnv("STRIPE_SECRET_KEY");
      const aiCreditsPriceId = getAiCreditsPriceId();
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
        .select({ _id: 1, stripeCustomerId: 1, stripeSubscriptionId: 1, status: 1, kind: 1 })
        .lean();

      // Guard: never create a second subscription for a workspace that already has one, of
      // either kind — Stripe subscriptions are not stacked here, and switching what an existing
      // one is for is a portal / support action, not a second Checkout.
      if (isBillableSubscription(existingSub as { status?: unknown; kind?: unknown } | null)) {
        const appUrl = appUrlFromRequest(request);
        return NextResponse.json(
          {
            error: "This workspace already has an active subscription. Manage it from the billing portal.",
            code: "SUBSCRIPTION_ALREADY_ACTIVE",
            status: String((existingSub as any).status),
            kind: (existingSub as any)?.kind === "payg" ? "payg" : "pro",
            // Hint for clients: POST here to obtain a Stripe billing portal URL.
            portalUrl: `${appUrl}/api/stripe/portal`,
          },
          { status: 409 },
        );
      }

      const { customerId, workspaceName } = await ensureWorkspaceStripeCustomer({
        stripe,
        orgId,
        userId,
        email: typeof (user as any)?.email === "string" ? String((user as any).email) : null,
      });

      const { successUrl, cancelUrl } = checkoutRedirects(request);
      const lineItems = [
        { price: priceId, quantity: 1 },
        // Metered prices must be added WITHOUT a quantity (Stripe rejects it).
        ...(aiCreditsPriceId ? [{ price: aiCreditsPriceId }] : []),
      ];
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        line_items: lineItems,
        success_url: successUrl,
        cancel_url: cancelUrl,
        // Use orgId here so Checkout completion can be mapped even if metadata is missing.
        client_reference_id: String(orgId),
        allow_promotion_codes: true,
        // Checkout otherwise shows only the product, and a second workspace's upgrade looks the same
        // as the first's. Say which workspace this subscription is for.
        custom_text: {
          submit: {
            message: `This subscribes ${workspaceName} to Pro. Your other workspaces keep their own plans.`,
          },
        },
        // Include userId, orgId AND kind so webhooks can update the correct workspace as the
        // right kind even before the subscription's own items are inspected.
        metadata: { userId: String(userId), orgId: String(orgId), kind: plan },
        // Helpful for correlating subscription webhooks back to this user.
        subscription_data: { metadata: { userId: String(userId), orgId: String(orgId), kind: plan } },
      });

      const url = typeof session?.url === "string" ? session.url : "";
      if (!url) throw new Error("Failed to create Checkout Session");

      return NextResponse.json({ url });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  });
}


