/**
 * API route for `/api/stripe/webhook` — Stripe webhook handler (source of truth for paid access).
 *
 * Security-sensitive:
 * - Verifies the Stripe signature using the raw request body.
 * - Updates MongoDB to grant/revoke access; the client redirect is NOT trusted.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import Stripe from "stripe";

import { connectMongo } from "@/lib/mongodb";
import { StripeEventModel } from "@/lib/models/StripeEvent";
import { SubscriptionModel } from "@/lib/models/Subscription";

export const runtime = "nodejs";

function mustGetEnv(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function isDuplicateKeyError(err: unknown): boolean {
  const e = err as { code?: unknown } | null;
  return Boolean(e && typeof e.code === "number" && e.code === 11000);
}

function asIdString(v: unknown): string {
  if (!v) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "object" && v && "id" in (v as any) && typeof (v as any).id === "string") return String((v as any).id).trim();
  return "";
}

function userIdFromSession(session: Stripe.Checkout.Session): string {
  const metaId = typeof session?.metadata?.userId === "string" ? session.metadata.userId.trim() : "";
  if (metaId) return metaId;
  return "";
}

function orgIdFromSession(session: Stripe.Checkout.Session): string {
  const metaId = typeof session?.metadata?.orgId === "string" ? session.metadata.orgId.trim() : "";
  if (metaId) return metaId;
  const ref = typeof session?.client_reference_id === "string" ? session.client_reference_id.trim() : "";
  return ref;
}

function orgIdFromSubscription(sub: Stripe.Subscription): string {
  const metaId = typeof (sub as any)?.metadata?.orgId === "string" ? String((sub as any).metadata.orgId).trim() : "";
  return metaId;
}

function isProStatus(status: string): boolean {
  const s = (status ?? "").trim().toLowerCase();
  return s === "active" || s === "trialing";
}

export async function POST(request: Request) {
  const stripeKey = mustGetEnv("STRIPE_SECRET_KEY");
  const webhookSecret = mustGetEnv("STRIPE_WEBHOOK_SECRET");
  const stripe = new Stripe(stripeKey);

  // IMPORTANT: Use raw body string for signature verification (do not JSON-parse first).
  const body = await request.text();
  const sig = request.headers.get("stripe-signature") ?? "";
  if (!sig) return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid signature";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    await connectMongo();

    // Idempotency: record the event id once. If Stripe retries, the duplicate insert is skipped.
    try {
      await StripeEventModel.create({ eventId: event.id, type: event.type, createdAt: new Date() });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        return NextResponse.json({ received: true });
      }
      throw err;
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const orgIdRaw = orgIdFromSession(session);
      if (!orgIdRaw || !Types.ObjectId.isValid(orgIdRaw)) {
        return NextResponse.json({ received: true });
      }
      const orgId = new Types.ObjectId(orgIdRaw);
      const customerId = asIdString(session.customer);
      const subscriptionId = asIdString(session.subscription);

      // Workspace-bound: persist identifiers on the org subscription row.
      // NOTE: We do NOT grant access here; access is based on subscription status webhooks.
      await SubscriptionModel.updateOne(
        { orgId, isDeleted: { $ne: true } },
        {
          $setOnInsert: { orgId, isDeleted: false },
          $set: {
            ...(customerId ? { stripeCustomerId: customerId } : {}),
            ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
          },
        },
        { upsert: true },
      );

      return NextResponse.json({ received: true });
    }

    if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
      const sub = event.data.object as Stripe.Subscription;
      const subscriptionId = asIdString(sub.id);
      const customerId = asIdString(sub.customer);
      const status = typeof sub.status === "string" ? sub.status : "";
      const currentPeriodEnd =
        typeof sub.current_period_end === "number" && Number.isFinite(sub.current_period_end)
          ? new Date(sub.current_period_end * 1000)
          : null;
      const cancelAtPeriodEnd = Boolean((sub as any)?.cancel_at_period_end);

      // Prefer orgId from subscription metadata (best), then subscriptionId, then customerId.
      const orgIdRaw = orgIdFromSubscription(sub);
      const orgId = orgIdRaw && Types.ObjectId.isValid(orgIdRaw) ? new Types.ObjectId(orgIdRaw) : null;
      const query = orgId
        ? { orgId, isDeleted: { $ne: true } }
        : subscriptionId
          ? { stripeSubscriptionId: subscriptionId, isDeleted: { $ne: true } }
          : customerId
            ? { stripeCustomerId: customerId, isDeleted: { $ne: true } }
            : null;
      if (!query) return NextResponse.json({ received: true });

      const pro = isProStatus(status);
      await SubscriptionModel.updateOne(
        query,
        {
          $setOnInsert: orgId ? { orgId, isDeleted: false } : {},
          $set: {
            status: status || "free",
            planName: pro ? "Pro" : "Free",
            currentPeriodEnd,
            cancelAtPeriodEnd,
            ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
            ...(customerId ? { stripeCustomerId: customerId } : {}),
          },
        },
        { upsert: Boolean(orgId) },
      );

      return NextResponse.json({ received: true });
    }

    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object as Stripe.Subscription;
      const subscriptionId = asIdString(sub.id);
      if (!subscriptionId) return NextResponse.json({ received: true });

      await SubscriptionModel.updateOne(
        { stripeSubscriptionId: subscriptionId, isDeleted: { $ne: true } },
        {
          $set: {
            status: "free",
            planName: "Free",
            currentPeriodEnd: null,
            cancelAtPeriodEnd: false,
          },
        },
      );

      return NextResponse.json({ received: true });
    }

    // Ignore other event types (but still ACK so Stripe stops retrying).
    return NextResponse.json({ received: true });
  } catch (err) {
    // Stripe expects a 2xx when received; however, we return 400 for unexpected processing errors
    // so we get retries during transient DB issues.
    const message = err instanceof Error ? err.message : "Webhook processing failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


