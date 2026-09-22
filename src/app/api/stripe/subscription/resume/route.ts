/**
 * API route for `POST /api/stripe/subscription/resume` — undo a scheduled cancellation.
 *
 * A cancelled Pro subscription stays active until its period ends. This clears the schedule in
 * Stripe (both forms: `cancel_at` from the portal's cancel flow and `cancel_at_period_end`) so it
 * renews as normal, without sending the person through the billing portal to find "Don't cancel".
 *
 * Security: signed-in owner/admin of the active workspace; the subscription is looked up from the
 * workspace, never from client input. The webhook records the change as well; this route also
 * writes it directly so the page that called it shows the new state immediately.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import Stripe from "stripe";

import { connectMongo } from "@/lib/mongodb";
import { resolveActor } from "@/lib/gating/actor";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { requireOrgRole } from "@/lib/orgs/requireOrgRole";
import { forbidApiKey } from "@/lib/gating/forbidApiKey";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActor(request);
    try {
      if (actor.kind !== "user") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      if (!Types.ObjectId.isValid(actor.orgId)) return NextResponse.json({ error: "Invalid org" }, { status: 400 });
      // Resuming restarts a recurring charge, so it is a billing action like starting or
      // cancelling one — and an `lnk_` key resolves to a `kind: "user"` actor, so the role check
      // below would have let an agent do it. Its three siblings all refuse a key here.
      const keyForbidden = forbidApiKey(actor, "resume a subscription");
      if (keyForbidden) return keyForbidden;
      const role = await requireOrgRole({ orgId: actor.orgId, userId: actor.userId, minRole: "admin" });
      if (!role.ok) return NextResponse.json({ error: "Only an owner or admin can change this workspace's subscription." }, { status: 403 });

      const stripeKey = (process.env.STRIPE_SECRET_KEY ?? "").trim();
      if (!stripeKey) return NextResponse.json({ error: "Payments are not configured for this deployment." }, { status: 400 });
      const stripe = new Stripe(stripeKey);

      await connectMongo();
      const orgId = new Types.ObjectId(actor.orgId);
      const sub = (await SubscriptionModel.findOne({ orgId, isDeleted: { $ne: true } })
        .select({ stripeSubscriptionId: 1 })
        .lean()) as { stripeSubscriptionId?: string | null } | null;
      const subscriptionId = (sub?.stripeSubscriptionId ?? "").trim();
      if (!subscriptionId) return NextResponse.json({ error: "This workspace has no subscription to resume." }, { status: 400 });

      const current = await stripe.subscriptions.retrieve(subscriptionId);
      if (current.status === "canceled" || current.status === "incomplete_expired") {
        return NextResponse.json({ error: "This subscription has already ended. Upgrade to Pro again to start a new one." }, { status: 409 });
      }
      const updated = current.cancel_at
        ? await stripe.subscriptions.update(subscriptionId, { cancel_at: "" })
        : current.cancel_at_period_end
          ? await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: false })
          : current;

      const periodEnd = updated.items.data[0]?.current_period_end;
      await SubscriptionModel.updateOne(
        { orgId, isDeleted: { $ne: true } },
        {
          $set: {
            cancelAtPeriodEnd: Boolean(updated.cancel_at || updated.cancel_at_period_end),
            ...(periodEnd ? { currentPeriodEnd: new Date(periodEnd * 1000) } : {}),
          },
        },
      );
      return NextResponse.json({ ok: true, cancelAtPeriodEnd: Boolean(updated.cancel_at || updated.cancel_at_period_end) });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 400 });
    }
  });
}
