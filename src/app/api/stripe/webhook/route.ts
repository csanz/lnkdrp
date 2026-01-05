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
import { debugLog } from "@/lib/debug";
import { StripeEventModel } from "@/lib/models/StripeEvent";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { grantCycleIncludedCredits, buildCycleKey } from "@/lib/credits/grants";
import {
  logErrorEvent,
  ERROR_CODE_STRIPE_WEBHOOK_INVALID_SIGNATURE,
  ERROR_CODE_STRIPE_WEBHOOK_PROCESSING_FAILED,
} from "@/lib/errors/logger";

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

function parseUnixSecondsToDate(v: unknown): Date | null {
  // Stripe timestamps are usually unix seconds (number), but API versions/clients may serialize as strings.
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v * 1000);
  if (typeof v === "bigint") return new Date(Number(v) * 1000);
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    const n = Number(s);
    if (Number.isFinite(n)) return new Date(n * 1000);
    // Fallback: tolerate ISO timestamps in case a client or proxy serialized it that way.
    const ms = Date.parse(s);
    if (Number.isFinite(ms)) return new Date(ms);
  }
  return null;
}

function parseStripeBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v !== 0 : null;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no") return false;
  }
  return null;
}

function parseUnixSecondsToDateStrict(v: unknown): Date | null {
  // Prefer unix seconds; tolerate strings for safety.
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v * 1000);
  if (typeof v === "bigint") return new Date(Number(v) * 1000);
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    const n = Number(s);
    if (Number.isFinite(n)) return new Date(n * 1000);
  }
  return null;
}

function priceIdFromSubscriptionItem(it: any): string {
  const pid = it?.price?.id;
  return typeof pid === "string" ? pid.trim() : "";
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
    void logErrorEvent({
      severity: "warn",
      category: "stripe",
      code: ERROR_CODE_STRIPE_WEBHOOK_INVALID_SIGNATURE,
      // Avoid persisting raw Stripe error objects here (they may include header details).
      message: "Invalid Stripe webhook signature",
      request,
      statusCode: 400,
      meta: { hasStripeSignatureHeader: Boolean(sig), reason: message },
    });
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    await connectMongo();

    debugLog(1, "[stripe:webhook] received", { id: event.id, type: event.type });

    // Idempotency: record the event id once. If Stripe retries, the duplicate insert is skipped.
    try {
      await StripeEventModel.create({ eventId: event.id, type: event.type, createdAt: new Date() });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        debugLog(2, "[stripe:webhook] duplicate (skipping)", { id: event.id, type: event.type });
        return NextResponse.json({ received: true });
      }
      throw err;
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const orgIdRaw = orgIdFromSession(session);
      if (!orgIdRaw || !Types.ObjectId.isValid(orgIdRaw)) {
        debugLog(2, "[stripe:webhook] checkout.session.completed missing orgId", {
          id: event.id,
          orgIdRaw,
          customer: asIdString(session.customer) || null,
          subscription: asIdString(session.subscription) || null,
        });
        return NextResponse.json({ received: true });
      }
      const orgId = new Types.ObjectId(orgIdRaw);
      const customerId = asIdString(session.customer);
      const subscriptionId = asIdString(session.subscription);

      // Workspace-bound: persist identifiers on the org subscription row.
      // NOTE: We do NOT grant access here; access is based on subscription status webhooks.
      const res = await SubscriptionModel.updateOne(
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
      debugLog(1, "[stripe:webhook] checkout.session.completed → subscription pointers saved", {
        id: event.id,
        orgId: String(orgId),
        customerId: customerId || null,
        subscriptionId: subscriptionId || null,
        matched: (res as any)?.matchedCount ?? null,
        modified: (res as any)?.modifiedCount ?? null,
        upsertedId: (res as any)?.upsertedId ?? null,
      });

      return NextResponse.json({ received: true });
    }

    if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
      const sub = event.data.object as Stripe.Subscription;
      const subscriptionId = asIdString(sub.id);
      const customerId = asIdString(sub.customer);
      debugLog(2, "[stripe:webhook] raw subscription payload (subset)", {
        id: event.id,
        type: event.type,
        sub: {
          id: subscriptionId || null,
          customer: customerId || null,
          status: typeof (sub as any)?.status === "string" ? String((sub as any).status) : null,
          cancel_at: (sub as any)?.cancel_at ?? null,
          cancel_at_period_end: (sub as any)?.cancel_at_period_end ?? null,
          current_period_end: (sub as any)?.current_period_end ?? null,
          metadata: (sub as any)?.metadata ?? null,
          // Include price ids only (useful for confirming which plan/price is being updated).
          priceIds: Array.isArray((sub as any)?.items?.data)
            ? (sub as any).items.data
                .map((it: any) => it?.price?.id)
                .filter((v: any) => typeof v === "string" && v)
            : [],
        },
      });
      let status = typeof sub.status === "string" ? sub.status : "";
      let currentPeriodStart = parseUnixSecondsToDateStrict((sub as any)?.current_period_start);
      let currentPeriodEnd = parseUnixSecondsToDate((sub as any)?.current_period_end);
      // When a subscription is set to cancel at a specific time, Stripe uses `cancel_at` (unix seconds).
      // Some portal flows set `cancel_at` (date) instead of toggling `cancel_at_period_end=true`.
      let cancelAt = parseUnixSecondsToDate((sub as any)?.cancel_at);
      let cancelAtPeriodEnd = parseStripeBool((sub as any)?.cancel_at_period_end) ?? false;
      let usedStripeFetch = false;

      // Robustness: if the webhook payload is missing key fields (API version differences),
      // fetch the subscription from Stripe by id to get authoritative values.
      if (
        subscriptionId &&
        (!currentPeriodStart || !currentPeriodEnd || !cancelAt || parseStripeBool((sub as any)?.cancel_at_period_end) === null)
      ) {
        try {
          const fresh = await stripe.subscriptions.retrieve(subscriptionId);
          usedStripeFetch = true;
          debugLog(2, "[stripe:webhook] stripe.subscriptions.retrieve (subset)", {
            id: event.id,
            subscriptionId,
            fresh: {
              status: typeof (fresh as any)?.status === "string" ? String((fresh as any).status) : null,
              cancel_at: (fresh as any)?.cancel_at ?? null,
              cancel_at_period_end: (fresh as any)?.cancel_at_period_end ?? null,
              current_period_end: (fresh as any)?.current_period_end ?? null,
              metadata: (fresh as any)?.metadata ?? null,
            },
          });
          status = typeof fresh.status === "string" ? fresh.status : status;
          currentPeriodStart = parseUnixSecondsToDateStrict((fresh as any)?.current_period_start) ?? currentPeriodStart;
          currentPeriodEnd = parseUnixSecondsToDate((fresh as any)?.current_period_end) ?? currentPeriodEnd;
          cancelAt = parseUnixSecondsToDate((fresh as any)?.cancel_at) ?? cancelAt;
          cancelAtPeriodEnd =
            parseStripeBool((fresh as any)?.cancel_at_period_end) ?? cancelAtPeriodEnd;
        } catch {
          // ignore; fall back to webhook payload best-effort
        }
      }

      // If Stripe provided a concrete cancellation timestamp, treat it as the effective end date.
      // This allows the UI to show “Cancels on <date>” even when `cancel_at_period_end` is false.
      const effectivePeriodEnd = cancelAt ?? currentPeriodEnd;
      const effectiveCancels = cancelAtPeriodEnd || Boolean(cancelAt);

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
      if (!query) {
        debugLog(2, "[stripe:webhook] subscription update missing mapping keys", {
          id: event.id,
          subscriptionId: subscriptionId || null,
          customerId: customerId || null,
          orgIdRaw: orgIdRaw || null,
          status: status || null,
          cancelAtPeriodEnd,
          cancelAt: cancelAt ? cancelAt.toISOString() : null,
          currentPeriodEnd: currentPeriodEnd ? currentPeriodEnd.toISOString() : null,
        });
        return NextResponse.json({ received: true });
      }

      const pro = isProStatus(status);
      const setFields: Record<string, unknown> = {
        status: status || "free",
        planName: pro ? "Pro" : "Free",
        cancelAtPeriodEnd: effectiveCancels,
        ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
        ...(customerId ? { stripeCustomerId: customerId } : {}),
      };
      if (currentPeriodStart) setFields.currentPeriodStart = currentPeriodStart;
      // Only overwrite the stored period end when we have a real date. This avoids losing the date
      // in cases where Stripe sends `current_period_end=null` while still clearing/setting cancel schedules.
      if (effectivePeriodEnd) setFields.currentPeriodEnd = effectivePeriodEnd;

      // Identify the metered subscription item for ai_credits by price id.
      const creditsPriceId = (process.env.STRIPE_AI_CREDITS_PRICE_ID ?? "").trim();
      if (creditsPriceId && Array.isArray((sub as any)?.items?.data)) {
        const items = (sub as any).items.data as any[];
        const match = items.find((it) => priceIdFromSubscriptionItem(it) === creditsPriceId);
        const itemId = match?.id;
        if (typeof itemId === "string" && itemId.trim()) {
          (setFields as any).stripeSubscriptionItemId = itemId.trim();
        }
      }

      const res = await SubscriptionModel.updateOne(
        query,
        {
          $setOnInsert: orgId ? { orgId, isDeleted: false } : {},
          $set: {
            ...setFields,
          },
        },
        { upsert: Boolean(orgId) },
      );
      debugLog(1, "[stripe:webhook] subscription updated → org subscription saved", {
        id: event.id,
        type: event.type,
        orgId: orgId ? String(orgId) : null,
        subscriptionId: subscriptionId || null,
        customerId: customerId || null,
        status: status || null,
        cancelAtPeriodEnd: effectiveCancels,
        effectivePeriodEnd: effectivePeriodEnd ? effectivePeriodEnd.toISOString() : null,
        rawCancelAtPeriodEnd: cancelAtPeriodEnd,
        rawCancelAt: cancelAt ? cancelAt.toISOString() : null,
        currentPeriodStart: currentPeriodStart ? currentPeriodStart.toISOString() : null,
        rawCurrentPeriodEnd: currentPeriodEnd ? currentPeriodEnd.toISOString() : null,
        usedStripeFetch,
        matched: (res as any)?.matchedCount ?? null,
        modified: (res as any)?.modifiedCount ?? null,
        upsertedId: (res as any)?.upsertedId ?? null,
      });

      // Idempotent cycle grant: reset included credits to 300 on new billing cycle.
      try {
        const orgIdStr = orgId ? String(orgId) : null;
        const start = currentPeriodStart;
        if (pro && orgIdStr && start) {
          const cycleKey = buildCycleKey({ stripeSubscriptionId: subscriptionId, currentPeriodStart: start });
          await grantCycleIncludedCredits({
            workspaceId: orgIdStr,
            stripeSubscriptionId: subscriptionId,
            currentPeriodStart: start,
            currentPeriodEnd: effectivePeriodEnd ?? null,
          });
          debugLog(1, "[stripe:webhook] cycle grant ensured", { orgId: orgIdStr, cycleKey });
        }
      } catch (e) {
        debugLog(2, "[stripe:webhook] cycle grant failed (non-fatal)", { message: e instanceof Error ? e.message : String(e) });
      }

      return NextResponse.json({ received: true });
    }

    if (event.type === "invoice.paid") {
      // Authoritative renewal signal; sync subscription from Stripe and ensure cycle grant.
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionId = asIdString((invoice as any)?.subscription);
      if (!subscriptionId) return NextResponse.json({ received: true });
      try {
        const fresh = await stripe.subscriptions.retrieve(subscriptionId);
        const orgIdRaw = orgIdFromSubscription(fresh);
        const orgId = orgIdRaw && Types.ObjectId.isValid(orgIdRaw) ? new Types.ObjectId(orgIdRaw) : null;
        const status = typeof fresh.status === "string" ? fresh.status : "";
        const pro = isProStatus(status);
        const currentPeriodStart = parseUnixSecondsToDateStrict((fresh as any)?.current_period_start);
        const currentPeriodEnd = parseUnixSecondsToDate((fresh as any)?.current_period_end);
        const creditsPriceId = (process.env.STRIPE_AI_CREDITS_PRICE_ID ?? "").trim();
        let stripeSubscriptionItemId: string | null = null;
        if (creditsPriceId && Array.isArray((fresh as any)?.items?.data)) {
          const items = (fresh as any).items.data as any[];
          const match = items.find((it) => priceIdFromSubscriptionItem(it) === creditsPriceId);
          stripeSubscriptionItemId = typeof match?.id === "string" ? match.id.trim() : null;
        }

        if (orgId) {
          await SubscriptionModel.updateOne(
            { orgId, isDeleted: { $ne: true } },
            {
              $set: {
                status: status || "free",
                planName: pro ? "Pro" : "Free",
                ...(currentPeriodStart ? { currentPeriodStart } : {}),
                ...(currentPeriodEnd ? { currentPeriodEnd } : {}),
                ...(stripeSubscriptionItemId ? { stripeSubscriptionItemId } : {}),
              },
            },
            { upsert: true },
          );
          if (pro && currentPeriodStart) {
            const cycleKey = buildCycleKey({ stripeSubscriptionId: subscriptionId, currentPeriodStart });
            await grantCycleIncludedCredits({
              workspaceId: String(orgId),
              stripeSubscriptionId: subscriptionId,
              currentPeriodStart,
              currentPeriodEnd: currentPeriodEnd ?? null,
            });
            debugLog(1, "[stripe:webhook] invoice.paid → cycle grant ensured", { orgId: String(orgId), cycleKey });
          }
        }
      } catch (e) {
        debugLog(2, "[stripe:webhook] invoice.paid handling failed (non-fatal)", { message: e instanceof Error ? e.message : String(e) });
      }
      return NextResponse.json({ received: true });
    }

    if (event.type === "invoice.payment_failed") {
      // Minimal policy: keep access state driven by subscription status; disable on-demand as a safety.
      // (Workspace on-demand settings are stored on WorkspaceCreditBalance; handled in reconcile/cron.)
      debugLog(1, "[stripe:webhook] invoice.payment_failed received", { id: event.id });
      return NextResponse.json({ received: true });
    }

    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object as Stripe.Subscription;
      const subscriptionId = asIdString(sub.id);
      if (!subscriptionId) {
        debugLog(2, "[stripe:webhook] subscription.deleted missing subscriptionId", { id: event.id });
        return NextResponse.json({ received: true });
      }

      const res = await SubscriptionModel.updateOne(
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
      debugLog(1, "[stripe:webhook] subscription.deleted → downgraded workspace", {
        id: event.id,
        subscriptionId,
        matched: (res as any)?.matchedCount ?? null,
        modified: (res as any)?.modifiedCount ?? null,
      });

      return NextResponse.json({ received: true });
    }

    // Ignore other event types (but still ACK so Stripe stops retrying).
    debugLog(2, "[stripe:webhook] ignored event type", { id: event.id, type: event.type });
    return NextResponse.json({ received: true });
  } catch (err) {
    // Stripe expects a 2xx when received; however, we return 400 for unexpected processing errors
    // so we get retries during transient DB issues.
    const message = err instanceof Error ? err.message : "Webhook processing failed";
    void logErrorEvent({
      severity: "error",
      category: "stripe",
      code: ERROR_CODE_STRIPE_WEBHOOK_PROCESSING_FAILED,
      err,
      request,
      statusCode: 400,
      meta: {
        stripeEventId: typeof (event as any)?.id === "string" ? (event as any).id : null,
        stripeEventType: typeof (event as any)?.type === "string" ? (event as any).type : null,
      },
    });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


