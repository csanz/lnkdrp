/**
 * API route for `/api/stripe/webhook` — Stripe webhook handler (source of truth for paid access).
 *
 * Security-sensitive:
 * - Verifies the Stripe signature using the raw request body.
 * - Updates MongoDB to grant/revoke access; the client redirect is NOT trusted.
 *
 * Idempotency (see `StripeEventModel`):
 * - A `StripeEvent` row is inserted (unique `eventId`) BEFORE processing.
 * - `processedAt` is set only after processing succeeds.
 * - On a retry: a row with `processedAt` set is ACKed without re-processing; a row without it
 *   (previous attempt threw → 400) is processed again.
 */
import { NextResponse } from "next/server";
import { resolveConfiguredSiteUrl } from "@/lib/urls";
import { Types } from "mongoose";
import Stripe from "stripe";

import { connectMongo } from "@/lib/mongodb";
import { debugLog } from "@/lib/debug";
import { StripeEventModel } from "@/lib/models/StripeEvent";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { WorkspaceCreditBalanceModel } from "@/lib/models/WorkspaceCreditBalance";
import { grantCycleIncludedCredits, buildCycleKey, creditWindowIndex } from "@/lib/credits/grants";
import { getAiCreditsPriceId } from "@/lib/credits/stripeReporting";
import { requeueSkippedSummaries } from "@/lib/credits/summaryRequeue";
import { grantCreditPack } from "@/lib/credits/purchases";
import { FREE_DAILY_CREDIT_CAP } from "@/lib/credits/creditService";
import {
  PAYG_DEFAULT_SPEND_LIMIT_CENTS,
  isBillableStatus,
  isOpenStatus,
  subscriptionIntervalFromItems,
  subscriptionKindFromPriceIds,
  type SubscriptionInterval,
  type SubscriptionKind,
} from "@/lib/billing/subscriptionState";
import { getInvoiceSubscriptionId, getSubscriptionPeriod } from "@/lib/billing/stripePeriods";
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

/**
 * What the subscription is for, read from its items: the Pro price → `pro`; the metered credits
 * price alone → `payg` (a Free workspace that added a card). Falls back to the `kind` the
 * Checkout route stamped in metadata, then to `null` (keep whatever is stored).
 */
function kindFromStripeSubscription(sub: unknown): SubscriptionKind | null {
  const items = (sub as any)?.items?.data;
  const priceIds: string[] = Array.isArray(items) ? items.map((it: any) => priceIdFromSubscriptionItem(it)).filter(Boolean) : [];
  const fromItems = subscriptionKindFromPriceIds({
    priceIds,
    proPriceId: (process.env.STRIPE_PRICE_ID ?? "").trim() || null,
    proAnnualPriceId: (process.env.STRIPE_PRICE_ID_ANNUAL ?? "").trim() || null,
    creditsPriceId: getAiCreditsPriceId(),
  });
  if (fromItems) return fromItems;
  const meta = (sub as any)?.metadata?.kind;
  return meta === "payg" || meta === "pro" ? meta : null;
}

/**
 * Pro is billable *and* on the Pro price. A row whose kind is unknown (no price id matched, no
 * metadata) is treated as Pro when billable, which is what every row from before `kind` existed
 * was — refusing them would silently downgrade paying customers on a config mismatch.
 */
function isProFor(status: string, kind: SubscriptionKind | null): boolean {
  return isBillableStatus(status) && kind !== "payg";
}

/** Plan label stored on the row and shown in the UI. */
function planNameFor(status: string, kind: SubscriptionKind | null): string {
  if (!isBillableStatus(status)) return "Free";
  return kind === "payg" ? "Pay as you go" : "Pro";
}

/**
 * A pay-as-you-go subscription just became billable: the workspace added a card to buy credits,
 * so on-demand must work at once. Turns it on with the default limit when none was ever set (an
 * explicit limit, including one the owner lowered, is left alone), then re-runs the summaries
 * that were skipped for want of credits — those are what they came to pay for.
 */
/**
 * Where this deployment reaches itself, for the self-call that re-runs skipped summaries.
 *
 * It read `NEXT_PUBLIC_APP_URL` alone and fell back to `http://localhost:3001`. On a deploy with
 * that variable unset, a customer buys credits, the webhook credits them correctly, and then the
 * self-call is made to localhost from inside the lambda: ECONNREFUSED, swallowed by a `.catch`,
 * logged only at debug level 2. The money lands and the summaries they paid for never run, with
 * nothing anywhere to say so.
 *
 * `resolveConfiguredSiteUrl` already knows the whole ladder - site URL, app URL, NextAuth URL, and
 * `VERCEL_URL`, which is always present on Vercel. The localhost fallback stays, but only outside
 * production, where it is the correct answer rather than a silent dead end.
 */
function appUrl(): string {
  const resolved = resolveConfiguredSiteUrl();
  if (resolved) return resolved.origin;
  if (process.env.NODE_ENV === "production") return "";
  return "http://localhost:3001";
}

async function activatePayAsYouGo(params: { orgId: Types.ObjectId; eventId: string }): Promise<void> {
  const res = await WorkspaceCreditBalanceModel.updateOne(
    { workspaceId: params.orgId, $or: [{ onDemandMonthlyLimitCents: { $exists: false } }, { onDemandMonthlyLimitCents: { $lte: 0 } }] },
    { $set: { onDemandEnabled: true, onDemandMonthlyLimitCents: PAYG_DEFAULT_SPEND_LIMIT_CENTS } },
  );
  if ((res as any)?.matchedCount === 0) {
    // A limit exists: only make sure the switch is on (it was turned off when the card failed or
    // the previous subscription ended).
    await WorkspaceCreditBalanceModel.updateOne({ workspaceId: params.orgId, onDemandEnabled: false }, { $set: { onDemandEnabled: true } });
  }
  debugLog(1, "[stripe:webhook] pay-as-you-go active → on-demand on", { id: params.eventId, orgId: String(params.orgId) });
  try {
    /**
     * Say so when this cannot run, rather than firing a request at nothing.
     *
     * The customer has just paid; the summaries are what they paid for. An unresolvable origin used
     * to mean a fetch to localhost from inside the lambda, refused, swallowed by the catch below,
     * and logged only at level 2 - money in, nothing done, nothing said. Level 1 is where the rest
     * of this route's real events are logged.
     */
    const origin = appUrl();
    if (!origin) {
      debugLog(1, "[stripe:webhook] cannot re-queue summaries: no site URL configured", {
        id: params.eventId,
        orgId: String(params.orgId),
        hint: "set NEXT_PUBLIC_SITE_URL or NEXT_PUBLIC_APP_URL",
      });
      return;
    }
    const { queued } = await requeueSkippedSummaries({ orgId: String(params.orgId), origin });
    debugLog(1, "[stripe:webhook] pay-as-you-go → skipped summaries re-queued", { id: params.eventId, orgId: String(params.orgId), queued });
  } catch (e) {
    debugLog(2, "[stripe:webhook] summary re-queue failed (non-fatal)", { message: e instanceof Error ? e.message : String(e) });
  }
}

/** Grant a paid credit pack to the workspace named in the Checkout metadata, then re-run skipped summaries. */
async function handleCreditPackCheckout(session: Stripe.Checkout.Session, eventId: string): Promise<void> {
  if (session.payment_status !== "paid") {
    debugLog(1, "[stripe:webhook] credit pack checkout not paid yet", { id: eventId, session: session.id, status: session.payment_status });
    return;
  }
  const orgId = orgIdFromSession(session);
  if (!orgId || !Types.ObjectId.isValid(orgId)) throw new Error(`credit pack checkout ${session.id} has no orgId`);
  const result = await grantCreditPack({
    orgId,
    userId: typeof session.metadata?.userId === "string" ? session.metadata.userId : null,
    packId: String(session.metadata?.packId ?? ""),
    checkoutSessionId: session.id,
    paymentIntentId: asIdString(session.payment_intent) || null,
    // Subtotal, not total: tax (if Stripe Tax is ever turned on) must not make a real payment
    // look like a price mismatch and fail every retry.
    amountCents: typeof session.amount_subtotal === "number" ? session.amount_subtotal : -1,
    expectedCents: Number(session.metadata?.priceCents) || null,
    currency: String(session.currency ?? ""),
    purchasedAt: new Date((typeof session.created === "number" ? session.created : Math.floor(Date.now() / 1000)) * 1000),
  });
  debugLog(1, "[stripe:webhook] credit pack granted", { id: eventId, orgId, credits: result.credits, alreadyGranted: result.alreadyGranted });
  if (result.alreadyGranted) return;
  try {
    const origin = appUrl();
    if (!origin) {
      debugLog(1, "[stripe:webhook] cannot re-queue summaries: no site URL configured", {
        orgId,
        hint: "set NEXT_PUBLIC_SITE_URL or NEXT_PUBLIC_APP_URL",
      });
      return;
    }
    const { queued } = await requeueSkippedSummaries({ orgId, origin });
    debugLog(1, "[stripe:webhook] credit pack → skipped summaries re-queued", { id: eventId, orgId, queued });
  } catch (e) {
    debugLog(2, "[stripe:webhook] summary re-queue failed (non-fatal)", { message: e instanceof Error ? e.message : String(e) });
  }
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

function priceIdFromSubscriptionItem(it: any): string {
  const pid = it?.price?.id;
  return typeof pid === "string" ? pid.trim() : "";
}

/**
 * Monthly or yearly, from the licensed item's `recurring.interval`. The metered credits item is
 * always monthly and is skipped. `null` when the payload carries no interval, so the stored value
 * is left alone rather than reset to monthly.
 */
function intervalFromStripeSubscription(sub: unknown): SubscriptionInterval | null {
  const items = (sub as any)?.items?.data;
  return Array.isArray(items) ? subscriptionIntervalFromItems(items) : null;
}

/** Find the metered AI-credits subscription item id (by configured price id), or `null`. */
function creditsSubscriptionItemId(sub: unknown): string | null {
  const creditsPriceId = getAiCreditsPriceId();
  const items = (sub as any)?.items?.data;
  if (!creditsPriceId || !Array.isArray(items)) return null;
  const match = (items as any[]).find((it) => priceIdFromSubscriptionItem(it) === creditsPriceId);
  const itemId = match?.id;
  return typeof itemId === "string" && itemId.trim() ? itemId.trim() : null;
}

/**
 * Safety valve: disable on-demand (overage) spending for a workspace when its subscription is
 * deleted or a payment fails. Reservation also re-checks subscription status, but flipping the
 * flag makes the state visible in the UI and keeps reconcile jobs consistent.
 */
async function disableOnDemandForSubscription(params: {
  query: Record<string, unknown>;
  reason: string;
  eventId: string;
}): Promise<void> {
  const sub = await SubscriptionModel.findOne({ ...params.query, isDeleted: { $ne: true } })
    .select({ orgId: 1 })
    .lean();
  const orgId = (sub as any)?.orgId;
  if (!orgId) {
    debugLog(2, "[stripe:webhook] on-demand disable skipped (no workspace match)", {
      id: params.eventId,
      reason: params.reason,
      query: params.query,
    });
    return;
  }
  const res = await WorkspaceCreditBalanceModel.updateOne(
    { workspaceId: orgId, onDemandEnabled: true },
    { $set: { onDemandEnabled: false } },
  );
  debugLog(1, "[stripe:webhook] on-demand disabled", {
    id: params.eventId,
    reason: params.reason,
    orgId: String(orgId),
    modified: (res as any)?.modifiedCount ?? null,
  });
}

/** The workspace a subscription query points at, or null when the row is gone. */
async function workspaceIdFor(query: Record<string, unknown>): Promise<Types.ObjectId | null> {
  const sub = await SubscriptionModel.findOne({ ...query, isDeleted: { $ne: true } }).select({ orgId: 1 }).lean();
  const orgId = (sub as { orgId?: Types.ObjectId } | null)?.orgId;
  return orgId ?? null;
}

/**
 * Put the Free daily credit brake back when a workspace stops being Pro.
 *
 * `grantCycleIncludedCredits` sets `dailyCreditCap: null` on the way up and nothing set it back on
 * the way down, so a cancelled Pro workspace kept its remaining subscription and starter credits
 * with no per-day limit: the brake exists to stop free-credit farming, and a lapsed Pro could burn
 * hundreds in a day. A pack purchase lifts the cap for good (`purchases.ts`), so a workspace
 * holding purchased credits is left alone.
 */
async function restoreFreeDailyCap(params: { query: Record<string, unknown>; reason: string; eventId: string }): Promise<void> {
  const orgId = await workspaceIdFor(params.query);
  if (!orgId) return;
  const res = await WorkspaceCreditBalanceModel.updateOne(
    {
      workspaceId: orgId,
      dailyCreditCap: null,
      $or: [{ purchasedCreditsRemaining: { $exists: false } }, { purchasedCreditsRemaining: { $lte: 0 } }],
    },
    { $set: { dailyCreditCap: FREE_DAILY_CREDIT_CAP } },
  );
  debugLog(1, "[stripe:webhook] free daily cap restored", {
    id: params.eventId,
    reason: params.reason,
    orgId: String(orgId),
    modified: (res as { modifiedCount?: number })?.modifiedCount ?? null,
  });
}

/** Pro has no daily brake; clear one left over from a lapse inside the current cycle. */
async function liftDailyCapForPro(params: { query: Record<string, unknown>; eventId: string }): Promise<void> {
  const orgId = await workspaceIdFor(params.query);
  if (!orgId) return;
  const res = await WorkspaceCreditBalanceModel.updateOne(
    { workspaceId: orgId, dailyCreditCap: { $ne: null } },
    { $set: { dailyCreditCap: null } },
  );
  if ((res as { modifiedCount?: number })?.modifiedCount) {
    debugLog(1, "[stripe:webhook] daily cap lifted for Pro", { id: params.eventId, orgId: String(orgId) });
  }
}

/**
 * Process one verified Stripe event.
 *
 * Throwing here yields a 400 so Stripe retries; the `StripeEvent` row stays with
 * `processedAt=null` and the retry re-runs this function.
 */
async function processStripeEvent(event: Stripe.Event, stripe: Stripe): Promise<void> {
  // Credit packs are one-time payments, not subscriptions. `completed` arrives with
  // `payment_status: "paid"` for cards; a delayed method (a bank debit) completes unpaid and is
  // granted when `async_payment_succeeded` follows. Either event may arrive twice; the grant is
  // idempotent per Checkout session.
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.mode === "payment" && session.metadata?.kind === "credit_pack") {
      await handleCreditPackCheckout(session, event.id);
      return;
    }
    if (event.type === "checkout.session.async_payment_succeeded") return;
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
      return;
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
    return;
  }

  if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
    const sub = event.data.object as Stripe.Subscription;
    const subscriptionId = asIdString(sub.id);
    const customerId = asIdString(sub.customer);
    const payloadPeriod = getSubscriptionPeriod(sub);
    debugLog(2, "[stripe:webhook] raw subscription payload (subset)", {
      id: event.id,
      type: event.type,
      sub: {
        id: subscriptionId || null,
        customer: customerId || null,
        status: typeof (sub as any)?.status === "string" ? String((sub as any).status) : null,
        cancel_at: (sub as any)?.cancel_at ?? null,
        cancel_at_period_end: (sub as any)?.cancel_at_period_end ?? null,
        current_period_start: payloadPeriod.start ? payloadPeriod.start.toISOString() : null,
        current_period_end: payloadPeriod.end ? payloadPeriod.end.toISOString() : null,
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
    let currentPeriodStart = payloadPeriod.start;
    let currentPeriodEnd = payloadPeriod.end;
    // When a subscription is set to cancel at a specific time, Stripe uses `cancel_at` (unix seconds).
    // Some portal flows set `cancel_at` (date) instead of toggling `cancel_at_period_end=true`.
    let cancelAt = parseUnixSecondsToDate((sub as any)?.cancel_at);
    let cancelAtPeriodEnd = parseStripeBool((sub as any)?.cancel_at_period_end) ?? false;
    let stripeSubscriptionItemId = creditsSubscriptionItemId(sub);
    let kind = kindFromStripeSubscription(sub);
    let interval = intervalFromStripeSubscription(sub);
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
        const freshPeriod = getSubscriptionPeriod(fresh);
        debugLog(2, "[stripe:webhook] stripe.subscriptions.retrieve (subset)", {
          id: event.id,
          subscriptionId,
          fresh: {
            status: typeof (fresh as any)?.status === "string" ? String((fresh as any).status) : null,
            cancel_at: (fresh as any)?.cancel_at ?? null,
            cancel_at_period_end: (fresh as any)?.cancel_at_period_end ?? null,
            current_period_start: freshPeriod.start ? freshPeriod.start.toISOString() : null,
            current_period_end: freshPeriod.end ? freshPeriod.end.toISOString() : null,
            metadata: (fresh as any)?.metadata ?? null,
          },
        });
        status = typeof fresh.status === "string" ? fresh.status : status;
        currentPeriodStart = freshPeriod.start ?? currentPeriodStart;
        currentPeriodEnd = freshPeriod.end ?? currentPeriodEnd;
        cancelAt = parseUnixSecondsToDate((fresh as any)?.cancel_at) ?? cancelAt;
        cancelAtPeriodEnd = parseStripeBool((fresh as any)?.cancel_at_period_end) ?? cancelAtPeriodEnd;
        stripeSubscriptionItemId = creditsSubscriptionItemId(fresh) ?? stripeSubscriptionItemId;
        kind = kindFromStripeSubscription(fresh) ?? kind;
        interval = intervalFromStripeSubscription(fresh) ?? interval;
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
      return;
    }

    /**
     * Ignore events for a subscription this workspace no longer tracks.
     *
     * The row is keyed by `metadata.orgId` first, so any subscription carrying this org's id can
     * write it. When a workspace ends up with two (a second Checkout while the first was
     * `past_due`, before Checkout refused that), events from either one overwrote the single row
     * in arrival order: `unpaid` from the old one downgraded a workspace that was paying for the
     * new one. The stored id wins while it is still open; a finished subscription (`free`,
     * `canceled`) leaves the row free for whatever replaces it, which is the resubscribe case.
     */
    if (orgId && subscriptionId) {
      const stored = (await SubscriptionModel.findOne({ orgId, isDeleted: { $ne: true } })
        .select({ stripeSubscriptionId: 1, status: 1 })
        .lean()) as { stripeSubscriptionId?: string | null; status?: string } | null;
      const storedId = (stored?.stripeSubscriptionId ?? "").trim();
      if (storedId && storedId !== subscriptionId && isOpenStatus(stored?.status)) {
        debugLog(1, "[stripe:webhook] ignored event for a subscription this workspace does not track", {
          id: event.id,
          type: event.type,
          orgId: String(orgId),
          eventSubscriptionId: subscriptionId,
          storedSubscriptionId: storedId,
          storedStatus: stored?.status ?? null,
        });
        return;
      }
    }

    const billable = isBillableStatus(status);
    const pro = isProFor(status, kind);
    const setFields: Record<string, unknown> = {
      status: status || "free",
      planName: planNameFor(status, kind),
      cancelAtPeriodEnd: effectiveCancels,
      ...(kind ? { kind } : {}),
      ...(interval ? { interval } : {}),
      ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
      ...(customerId ? { stripeCustomerId: customerId } : {}),
      // A yearly subscription carries no metered item (Stripe refuses the mix), so a stored item id
      // is stale from a monthly past and must not survive the switch: the reporter would post
      // meter events against an item that no longer exists.
      ...(interval === "year" ? { stripeSubscriptionItemId: null } : stripeSubscriptionItemId ? { stripeSubscriptionItemId } : {}),
    };
    if (currentPeriodStart) setFields.currentPeriodStart = currentPeriodStart;
    // Only overwrite the stored period end when we have a real date. This avoids losing the date
    // in cases where Stripe sends `current_period_end=null` while still clearing/setting cancel schedules.
    if (effectivePeriodEnd) setFields.currentPeriodEnd = effectivePeriodEnd;

    /**
     * Refuse to apply an event older than the one that last wrote this row.
     *
     * Stripe does not promise ordering and this route asks for retries, so the dangerous case is a
     * stale `updated` landing after a `deleted`: the row goes back to active, Stripe has nothing
     * more to send for a subscription that is gone, and the workspace sits on Pro for free.
     *
     * Expressed as a filter rather than a read-then-write so two events arriving together cannot
     * both pass the check. A row with no stamp yet - every row written before this field existed -
     * matches, so the first event after deploy always lands.
     */
    const eventCreatedAt = typeof event.created === "number" ? new Date(event.created * 1000) : null;
    const orderedQuery = eventCreatedAt
      ? { ...query, $or: [{ lastStripeEventAt: null }, { lastStripeEventAt: { $exists: false } }, { lastStripeEventAt: { $lte: eventCreatedAt } }] }
      : query;

    const update = {
      $set: {
        ...setFields,
        ...(eventCreatedAt ? { lastStripeEventAt: eventCreatedAt } : {}),
      },
    };
    let res: { matchedCount: number; upsertedCount: number; modifiedCount?: number; upsertedId?: unknown };
    try {
      res = await SubscriptionModel.updateOne(
        orderedQuery,
        { $setOnInsert: orgId ? { orgId, isDeleted: false } : {}, ...update },
        { upsert: Boolean(orgId) },
      );
    } catch (err) {
      /**
       * The ordering filter and the upsert fight when the row exists with a newer stamp: the
       * filter matches nothing, the upsert tries to insert a second row for the org, and the
       * unique `{orgId}` index refuses. That made the "ignored out-of-order" branch below
       * unreachable for any row carrying `metadata.orgId`: a delayed `updated` after a `deleted`
       * threw, this route answered 400, and Stripe retried the same event for three days, failing
       * identically each time. A duplicate key here is that case (or two first events for a new
       * org racing, which the retry below also settles): run the ordered update once more without
       * the upsert and let `matchedCount` decide.
       */
      if ((err as { code?: unknown } | null)?.code !== 11000) throw err;
      res = await SubscriptionModel.updateOne(orderedQuery, update);
    }
    if (eventCreatedAt && res.matchedCount === 0 && res.upsertedCount === 0) {
      debugLog(1, "[stripe:webhook] ignored out-of-order subscription event", {
        id: event.id,
        type: event.type,
        eventCreated: eventCreatedAt.toISOString(),
        orgId: orgId ? String(orgId) : null,
      });
      return;
    }
    debugLog(1, "[stripe:webhook] subscription updated → org subscription saved", {
      id: event.id,
      type: event.type,
      orgId: orgId ? String(orgId) : null,
      subscriptionId: subscriptionId || null,
      customerId: customerId || null,
      status: status || null,
      kind,
      cancelAtPeriodEnd: effectiveCancels,
      effectivePeriodEnd: effectivePeriodEnd ? effectivePeriodEnd.toISOString() : null,
      rawCancelAtPeriodEnd: cancelAtPeriodEnd,
      rawCancelAt: cancelAt ? cancelAt.toISOString() : null,
      currentPeriodStart: currentPeriodStart ? currentPeriodStart.toISOString() : null,
      rawCurrentPeriodEnd: currentPeriodEnd ? currentPeriodEnd.toISOString() : null,
      stripeSubscriptionItemId,
      usedStripeFetch,
      matched: (res as any)?.matchedCount ?? null,
      modified: (res as any)?.modifiedCount ?? null,
      upsertedId: (res as any)?.upsertedId ?? null,
    });

    // Subscription no longer billable (canceled/unpaid/past_due) → on-demand overage must stop,
    // whichever kind it was. A billable pay-as-you-go subscription is the opposite case: the
    // workspace just added a card to buy credits, so on-demand comes on.
    if (!billable) {
      await disableOnDemandForSubscription({ query, reason: `subscription.${status || "unknown"}`, eventId: event.id });
      await restoreFreeDailyCap({ query, reason: `subscription.${status || "unknown"}`, eventId: event.id });
    } else if (interval === "year") {
      // Yearly Pro has nothing that could bill on-demand usage; a toggle left on from a monthly
      // past would keep allocating credits nobody invoices.
      await disableOnDemandForSubscription({ query, reason: "subscription.yearly", eventId: event.id });
    } else if (kind === "payg" && orgId) {
      await activatePayAsYouGo({ orgId, eventId: event.id });
    }
    if (pro) {
      // A subscription that recovered from `past_due` inside the same cycle gets no new cycle
      // grant (it is idempotent per cycle), so the brake restored while it was lapsed is lifted here.
      await liftDailyCapForPro({ query, eventId: event.id });
    }

    // Idempotent cycle grant: open this billing cycle's included credits
    // (`INCLUDED_CREDITS_PER_CYCLE`). On an annual plan this opens month 0 only; the
    // credits-cycle-reconcile cron opens the eleven that follow.
    try {
      const orgIdStr = orgId ? String(orgId) : null;
      const start = currentPeriodStart;
      if (pro && orgIdStr && start) {
        const monthIndex = creditWindowIndex(start, effectivePeriodEnd ?? null, new Date());
        const cycleKey = buildCycleKey({ stripeSubscriptionId: subscriptionId, currentPeriodStart: start, monthIndex });
        await grantCycleIncludedCredits({
          workspaceId: orgIdStr,
          stripeSubscriptionId: subscriptionId,
          currentPeriodStart: start,
          currentPeriodEnd: effectivePeriodEnd ?? null,
          monthIndex,
        });
        debugLog(1, "[stripe:webhook] cycle grant ensured", { orgId: orgIdStr, cycleKey });
      }
    } catch (e) {
      debugLog(2, "[stripe:webhook] cycle grant failed (non-fatal)", { message: e instanceof Error ? e.message : String(e) });
    }

    return;
  }

  if (event.type === "invoice.paid") {
    // Authoritative renewal signal; sync subscription from Stripe and ensure cycle grant.
    const invoice = event.data.object as Stripe.Invoice;
    const subscriptionId = getInvoiceSubscriptionId(invoice);
    if (!subscriptionId) return;
    try {
      const fresh = await stripe.subscriptions.retrieve(subscriptionId);
      const orgIdRaw = orgIdFromSubscription(fresh);
      const orgId = orgIdRaw && Types.ObjectId.isValid(orgIdRaw) ? new Types.ObjectId(orgIdRaw) : null;
      const status = typeof fresh.status === "string" ? fresh.status : "";
      const kind = kindFromStripeSubscription(fresh);
      const interval = intervalFromStripeSubscription(fresh);
      const pro = isProFor(status, kind);
      const { start: currentPeriodStart, end: currentPeriodEnd } = getSubscriptionPeriod(fresh);
      const stripeSubscriptionItemId = creditsSubscriptionItemId(fresh);

      if (orgId) {
        await SubscriptionModel.updateOne(
          { orgId, isDeleted: { $ne: true } },
          {
            $setOnInsert: { orgId, isDeleted: false },
            $set: {
              status: status || "free",
              planName: planNameFor(status, kind),
              ...(kind ? { kind } : {}),
              ...(interval ? { interval } : {}),
              stripeSubscriptionId: subscriptionId,
              ...(currentPeriodStart ? { currentPeriodStart } : {}),
              ...(currentPeriodEnd ? { currentPeriodEnd } : {}),
              ...(stripeSubscriptionItemId ? { stripeSubscriptionItemId } : {}),
            },
          },
          { upsert: true },
        );
        if (pro && currentPeriodStart) {
          const monthIndex = creditWindowIndex(currentPeriodStart, currentPeriodEnd ?? null, new Date());
          const cycleKey = buildCycleKey({ stripeSubscriptionId: subscriptionId, currentPeriodStart, monthIndex });
          await grantCycleIncludedCredits({
            workspaceId: String(orgId),
            stripeSubscriptionId: subscriptionId,
            currentPeriodStart,
            currentPeriodEnd: currentPeriodEnd ?? null,
            monthIndex,
          });
          debugLog(1, "[stripe:webhook] invoice.paid → cycle grant ensured", { orgId: String(orgId), cycleKey });
        }
        // A paid invoice on a pay-as-you-go subscription (the first $0 one, or a month's usage)
        // re-arms on-demand if a failed payment had switched it off.
        if (kind === "payg" && isBillableStatus(status)) {
          await activatePayAsYouGo({ orgId, eventId: event.id });
        }
      }
    } catch (e) {
      debugLog(2, "[stripe:webhook] invoice.paid handling failed (non-fatal)", { message: e instanceof Error ? e.message : String(e) });
    }
    return;
  }

  if (event.type === "invoice.payment_failed") {
    // Policy: access state stays driven by subscription status; on-demand overage is disabled as a
    // safety so a workspace with a failing payment method cannot keep accruing metered charges.
    const invoice = event.data.object as Stripe.Invoice;
    const subscriptionId = getInvoiceSubscriptionId(invoice);
    const customerId = asIdString((invoice as any)?.customer);
    debugLog(1, "[stripe:webhook] invoice.payment_failed received", {
      id: event.id,
      subscriptionId: subscriptionId || null,
      customerId: customerId || null,
    });
    const query = subscriptionId
      ? { stripeSubscriptionId: subscriptionId }
      : customerId
        ? { stripeCustomerId: customerId }
        : null;
    if (query) {
      await disableOnDemandForSubscription({ query, reason: "invoice.payment_failed", eventId: event.id });
    }
    return;
  }

  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object as Stripe.Subscription;
    const subscriptionId = asIdString(sub.id);
    if (!subscriptionId) {
      debugLog(2, "[stripe:webhook] subscription.deleted missing subscriptionId", { id: event.id });
      return;
    }

    const query = { stripeSubscriptionId: subscriptionId, isDeleted: { $ne: true } };
    // Disable on-demand first (needs the workspace mapping, which the row still holds), and put
    // the Free daily brake back for the same reason.
    await disableOnDemandForSubscription({ query, reason: "customer.subscription.deleted", eventId: event.id });
    await restoreFreeDailyCap({ query, reason: "customer.subscription.deleted", eventId: event.id });

    /**
     * The same ordering guard the update handler carries, in the other direction.
     *
     * A stale `deleted` landing after a newer `updated` would downgrade a workspace that has since
     * resubscribed, and no further event would come to correct it.
     */
    const deletedAt = typeof event.created === "number" ? new Date(event.created * 1000) : null;
    const orderedQuery = deletedAt
      ? { ...query, $or: [{ lastStripeEventAt: null }, { lastStripeEventAt: { $exists: false } }, { lastStripeEventAt: { $lte: deletedAt } }] }
      : query;

    const res = await SubscriptionModel.updateOne(orderedQuery, {
      $set: {
        status: "free",
        planName: "Free",
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        stripeSubscriptionItemId: null,
        ...(deletedAt ? { lastStripeEventAt: deletedAt } : {}),
      },
    });
    debugLog(1, "[stripe:webhook] subscription.deleted → downgraded workspace", {
      id: event.id,
      subscriptionId,
      matched: (res as any)?.matchedCount ?? null,
      modified: (res as any)?.modifiedCount ?? null,
    });
    return;
  }

  // Ignore other event types (but still ACK so Stripe stops retrying).
  debugLog(2, "[stripe:webhook] ignored event type", { id: event.id, type: event.type });
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

    // Idempotency: insert the event row first (unique on eventId). If it already exists:
    // - processedAt set   → already handled; ACK without re-processing
    // - processedAt unset → a previous attempt failed (we returned 400); process again
    try {
      await StripeEventModel.create({ eventId: event.id, type: event.type, createdAt: new Date(), processedAt: null });
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      const existing = await StripeEventModel.findOne({ eventId: event.id }).select({ processedAt: 1 }).lean();
      if ((existing as any)?.processedAt) {
        debugLog(2, "[stripe:webhook] duplicate (already processed; skipping)", { id: event.id, type: event.type });
        return NextResponse.json({ received: true, alreadyProcessed: true });
      }
      debugLog(1, "[stripe:webhook] retry of unprocessed event (re-processing)", { id: event.id, type: event.type });
    }

    await processStripeEvent(event, stripe);

    await StripeEventModel.updateOne({ eventId: event.id }, { $set: { processedAt: new Date() } });
    return NextResponse.json({ received: true });
  } catch (err) {
    // Stripe expects a 2xx when received; however, we return 400 for unexpected processing errors
    // so we get retries during transient DB issues. The StripeEvent row keeps `processedAt=null`,
    // so the retry is processed instead of being short-circuited as a duplicate.
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
