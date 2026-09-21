/**
 * API route for `/api/billing/subscription/manage` — creates a Stripe customer portal session URL.
 *
 * A portal session is not a read. Whoever opens it can cancel or downgrade the workspace's plan,
 * swap or delete the card, and download every past invoice — and an invoice carries the paying
 * owner's name, email and billing address. This handler checked membership and nothing else, so a
 * `viewer` — the read-only seat handed to outside reviewers and clients — could end the plan for
 * everyone in the workspace and read the owner's billing identity while doing it.
 *
 * Owner or admin, which is the rule the rest of billing already states: the dashboard shows the
 * Manage button on `role === "owner" || role === "admin"` (`SubscriptionCard.tsx`), and the cancel
 * branch of `/api/stripe/portal` requires `admin`. Anything lower here would have been an end-run
 * around that cancel gate, since the plain portal reaches the same cancel screen.
 */
import { NextResponse } from "next/server";
import { errorJson } from "@/lib/http/errorResponse";
import { Types } from "mongoose";
import Stripe from "stripe";
import { connectMongo } from "@/lib/mongodb";
import { resolveActor, tryResolveUserActorFast } from "@/lib/gating/actor";
import { forbidApiKey } from "@/lib/gating/forbidApiKey";
import { requireOrgRole } from "@/lib/orgs/requireOrgRole";
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
    // Money is not document work: a key that could open the portal could cancel the plan that pays
    // for it. See `src/lib/gating/forbidApiKey.ts`.
    const keyForbidden = forbidApiKey(actor, "open the billing portal");
    if (keyForbidden) return keyForbidden;
    const role = await requireOrgRole({ orgId: actor.orgId, userId: actor.userId, minRole: "admin" });
    if (!role.ok) {
      return NextResponse.json(
        { error: "Only an owner or admin can manage this workspace's billing." },
        { status: 403 },
      );
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
    // A caught failure here is ours, not the caller's: the raw message went straight to the
    // browser (Mongo and Stripe internals included) and nothing reached the logs. `errorJson`
    // redacts, logs one line always, and keeps `detail` for non-production.
    return errorJson(err, { status: 500, publicMessage: "Could not open the billing portal.", context: "[api/billing/subscription/manage] POST failed" });
  }
}


