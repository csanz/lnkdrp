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
import { UserModel } from "@/lib/models/User";
import { StripeEventModel } from "@/lib/models/StripeEvent";

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
  const ref = typeof session?.client_reference_id === "string" ? session.client_reference_id.trim() : "";
  return ref;
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
      const userIdRaw = userIdFromSession(session);
      if (!userIdRaw || !Types.ObjectId.isValid(userIdRaw)) {
        return NextResponse.json({ received: true });
      }
      const userId = new Types.ObjectId(userIdRaw);
      const customerId = asIdString(session.customer);
      const subscriptionId = asIdString(session.subscription);

      // NOTE: We do NOT grant plan=pro here. Access is based on subscription status webhooks.
      await UserModel.updateOne(
        { _id: userId },
        {
          $set: {
            ...(customerId ? { stripeCustomerId: customerId } : {}),
            ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
          },
        },
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

      // Prefer subscriptionId match (strong), fallback to customerId (weak but practical).
      const query =
        subscriptionId
          ? { stripeSubscriptionId: subscriptionId }
          : customerId
            ? { stripeCustomerId: customerId }
            : null;
      if (!query) return NextResponse.json({ received: true });

      await UserModel.updateOne(query, {
        $set: {
          plan: isProStatus(status) ? "pro" : "free",
          stripeSubscriptionStatus: status || null,
          stripeCurrentPeriodEnd: currentPeriodEnd,
          ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
          ...(customerId ? { stripeCustomerId: customerId } : {}),
          // We don't currently store cancelAtPeriodEnd on the user; add later if needed.
          ...(cancelAtPeriodEnd ? {} : {}),
        },
      });

      return NextResponse.json({ received: true });
    }

    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object as Stripe.Subscription;
      const subscriptionId = asIdString(sub.id);
      if (!subscriptionId) return NextResponse.json({ received: true });

      await UserModel.updateOne(
        { stripeSubscriptionId: subscriptionId },
        {
          $set: {
            plan: "free",
            stripeSubscriptionStatus: "canceled",
            stripeCurrentPeriodEnd: null,
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


