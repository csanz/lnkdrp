/**
 * Cron route: `GET|POST /api/cron/stripe-credits-reconcile`
 *
 * Backstop job for credit cycles:
 * - fetch active Stripe subscriptions (stalest stored period end first)
 * - sync currentPeriodStart/currentPeriodEnd onto our `Subscription` record
 * - ensure included credits reset/grant is applied once per cycleKey
 *
 * Vercel Cron invokes this with `GET` + `Authorization: Bearer $CRON_SECRET`;
 * `POST` is kept for manual/dev invocation. Auth: `requireCronAuth`.
 *
 * Bounded by `?limit=` (default 200, max 1000). Subscriptions are ordered by
 * `currentPeriodEnd` ascending (nulls first) so the most out-of-date rows are
 * processed first and every subscription is eventually visited across runs.
 *
 * Overlap protection: holds a `CronHealth` lease for the duration of the run and
 * returns `{ skipped: "locked" }` (200) when another run is in progress.
 */
import { NextResponse } from "next/server";
import Stripe from "stripe";

import { connectMongo } from "@/lib/mongodb";
import { CronHealthModel } from "@/lib/models/CronHealth";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { isProSubscription } from "@/lib/billing/subscriptionState";
import { grantCycleIncludedCredits } from "@/lib/credits/grants";
import { logErrorEvent, ERROR_CODE_CRON_JOB_FAILED } from "@/lib/errors/logger";
import { getSubscriptionPeriod } from "@/lib/billing/stripePeriods";
import { debugError } from "@/lib/debug";
import { requireCronAuth } from "@/lib/cron/auth";
import { acquireCronLease, releaseCronLease } from "@/lib/cron/lease";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Lease TTL: slightly above `maxDuration` so a crashed run auto-expires. */
const LEASE_TTL_MS = 6 * 60 * 1000;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
}


/**
 * Shared handler for GET (Vercel Cron) and POST (manual) invocations.
 */
async function handle(request: Request) {
  const unauthorized = requireCronAuth(request);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const startedAt = new Date();
  const jobKey = "stripe-credits-reconcile";
  const limit = Math.min(MAX_LIMIT, asPositiveInt(url.searchParams.get("limit")) ?? DEFAULT_LIMIT);

  const lease = await acquireCronLease({ jobKey, ttlMs: LEASE_TTL_MS });
  if (!lease) {
    return NextResponse.json({ ok: true, skipped: "locked", jobKey });
  }

  try {
    await connectMongo();
    await CronHealthModel.updateOne(
      { jobKey },
      {
        $set: {
          status: "running",
          lastStartedAt: startedAt,
          lastRunAt: startedAt,
          lastParams: { limit },
          lastError: null,
        },
      },
      { upsert: true },
    );
  } catch {
    // ignore
  }

  try {
    const stripeKey = (process.env.STRIPE_SECRET_KEY ?? "").trim();
    if (!stripeKey) throw new Error("Missing STRIPE_SECRET_KEY");
    const stripe = new Stripe(stripeKey);

    await connectMongo();
    // Stalest stored period end first. MongoDB sorts null/missing before dates in
    // ascending order, so never-synced rows are visited first.
    const subs = await SubscriptionModel.find({
      isDeleted: { $ne: true },
      status: { $in: ["active", "trialing"] },
      stripeSubscriptionId: { $ne: null },
    })
      .sort({ currentPeriodEnd: 1, _id: 1 })
      .limit(limit)
      .select({ orgId: 1, stripeSubscriptionId: 1, currentPeriodStart: 1, currentPeriodEnd: 1, status: 1, kind: 1 })
      .lean();

    let processed = 0;
    let updated = 0;
    let granted = 0;
    let errors = 0;

    for (const s of subs) {
      processed += 1;
      const subId = typeof (s as any)?.stripeSubscriptionId === "string" ? String((s as any).stripeSubscriptionId) : "";
      const orgId = (s as any)?.orgId ? String((s as any).orgId) : "";
      if (!subId || !orgId) continue;

      // Per-subscription isolation: one bad Stripe/DB call must not abort the run.
      try {
        const fresh: Stripe.Subscription = await stripe.subscriptions.retrieve(subId);

        const status = typeof fresh.status === "string" ? fresh.status : "";
        // Pay-as-you-go rows sync their period like any other (the meter bills by it) but never
        // receive the 300 included credits.
        const pro = isProSubscription({ status, kind: (s as { kind?: unknown }).kind });
        // stripe@20 (API 2025-12-15) reports the period on subscription items, not the top level.
        const { start: currentPeriodStart, end: currentPeriodEnd } = getSubscriptionPeriod(fresh);
        if (!currentPeriodStart || !currentPeriodEnd) continue;

        const prevStart = (s as any)?.currentPeriodStart instanceof Date ? (s as any).currentPeriodStart : null;
        const prevEnd = (s as any)?.currentPeriodEnd instanceof Date ? (s as any).currentPeriodEnd : null;

        /**
         * Status counts as a change, not only the period.
         *
         * The write below sets `status` as well as the two dates, but the gate only compared the
         * dates — so a subscription Stripe had moved to `past_due`, `canceled` or `unpaid` inside
         * the same billing period never had that written. The row kept saying `active` until the
         * period happened to roll, and this job exists precisely because the webhook may have been
         * missed. Reconciling everything except the field most likely to have gone stale is the
         * one outcome it must not have.
         */
        const prevStatus = typeof (s as { status?: unknown }).status === "string" ? (s as { status: string }).status : "";
        const nextStatus = status || prevStatus;

        const changed =
          nextStatus !== prevStatus ||
          !prevStart ||
          prevStart.getTime() !== currentPeriodStart.getTime() ||
          !prevEnd ||
          prevEnd.getTime() !== currentPeriodEnd.getTime();

        if (changed) {
          await SubscriptionModel.updateOne(
            { _id: (s as any)._id },
            { $set: { status: nextStatus, currentPeriodStart, currentPeriodEnd } },
          );
          updated += 1;
        }

        if (pro) {
          const res = await grantCycleIncludedCredits({
            workspaceId: orgId,
            stripeSubscriptionId: subId,
            currentPeriodStart,
            currentPeriodEnd,
          });
          if (!res.alreadyGranted) granted += 1;
        }
      } catch (err) {
        errors += 1;
        debugError(1, "[cron:stripe-credits-reconcile] subscription failed", {
          subId,
          orgId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const finishedAt = new Date();
    const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
    const result = { processed, updated, granted, errors, limit };
    // Item-level failures record `error` so /api/monitor/crons alerts; the response stays 200.
    const failure = errors > 0 ? `${errors} of ${processed} subscriptions failed` : null;
    try {
      await connectMongo();
      await CronHealthModel.updateOne(
        { jobKey },
        {
          $set: {
            status: failure ? "error" : "ok",
            lastFinishedAt: finishedAt,
            lastRunAt: finishedAt,
            lastDurationMs: durationMs,
            lastResult: result,
            ...(failure ? { lastErrorAt: finishedAt, lastError: failure } : {}),
          },
        },
        { upsert: true },
      );
    } catch {
      // ignore
    }

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const finishedAt = new Date();
    const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
    const message = err instanceof Error ? err.message : String(err);

    void logErrorEvent({
      severity: "error",
      category: "cron",
      code: ERROR_CODE_CRON_JOB_FAILED,
      err,
      request,
      statusCode: 500,
      meta: { jobKey, params: { limit }, durationMs },
    });
    try {
      await connectMongo();
      await CronHealthModel.updateOne(
        { jobKey },
        {
          $set: {
            status: "error",
            lastFinishedAt: finishedAt,
            lastRunAt: finishedAt,
            lastDurationMs: durationMs,
            lastErrorAt: finishedAt,
            lastError: message,
          },
        },
        { upsert: true },
      );
    } catch {
      // ignore
    }
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await releaseCronLease(lease);
  }
}

/** Vercel Cron entrypoint. */
export const GET = handle;
/** Manual/dev entrypoint. */
export const POST = handle;
