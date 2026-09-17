/**
 * API route for `/api/stripe/portal` — creates a Stripe billing portal session URL.
 *
 * Security:
 * - Requires an authenticated user.
 * - Workspace-bound: uses the active org's `Subscription.stripeCustomerId`; does not trust client input.
 *
 * Body `{ flow: "cancel" }` (owner/admin only) opens Stripe's cancel-subscription flow for the
 * workspace's subscription and redirects back to `/dashboard?tab=billing&subscription=canceled`
 * when it completes. The plain portal has no completion redirect, only a "Return to" link, so
 * cancelling there used to leave the person on Stripe with no sign in lnkdrp that anything changed.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import Stripe from "stripe";

import { connectMongo } from "@/lib/mongodb";
import { resolveActor } from "@/lib/gating/actor";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { requireOrgRole } from "@/lib/orgs/requireOrgRole";

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
  return withMongoRequestLogging(request, async () => {
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
      const body = (await request.json().catch(() => null)) as { flow?: unknown } | null;
      const wantsCancel = body?.flow === "cancel";
      const sub = await SubscriptionModel.findOne({ orgId, isDeleted: { $ne: true } })
        .select({ stripeCustomerId: 1, stripeSubscriptionId: 1, cancelAtPeriodEnd: 1 })
        .lean();
      const customerId =
        typeof (sub as any)?.stripeCustomerId === "string" ? String((sub as any).stripeCustomerId).trim() : "";
      if (!customerId) {
        return NextResponse.json({ error: "No Stripe customer found for this workspace." }, { status: 400 });
      }

      const appUrl = appUrlFromRequest(request);
      const returnUrl = `${appUrl}/dashboard?tab=billing`;

      if (wantsCancel) {
        const role = await requireOrgRole({ orgId: actor.orgId, userId: actor.userId, minRole: "admin" });
        if (!role.ok) return NextResponse.json({ error: "Only an owner or admin can cancel this workspace's subscription." }, { status: 403 });
        const subscriptionId = typeof (sub as any)?.stripeSubscriptionId === "string" ? String((sub as any).stripeSubscriptionId).trim() : "";
        if (!subscriptionId) return NextResponse.json({ error: "This workspace has no subscription to cancel." }, { status: 400 });
        if ((sub as any)?.cancelAtPeriodEnd) {
          return NextResponse.json({ error: "This subscription is already set to end. Resume it instead." }, { status: 409 });
        }
        const portal = await stripe.billingPortal.sessions.create({
          customer: customerId,
          return_url: returnUrl,
          flow_data: {
            type: "subscription_cancel",
            subscription_cancel: { subscription: subscriptionId },
            after_completion: { type: "redirect", redirect: { return_url: `${returnUrl}&subscription=canceled` } },
          },
        });
        if (!portal?.url) throw new Error("Failed to create billing portal session");
        return NextResponse.json({ url: portal.url });
      }

      const portal = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
      });
      const url = typeof portal?.url === "string" ? portal.url : "";
      if (!url) throw new Error("Failed to create billing portal session");

      return NextResponse.json({ url });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  });
}


