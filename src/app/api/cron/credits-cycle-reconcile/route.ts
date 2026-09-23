/**
 * Cron route: `GET|POST /api/cron/credits-cycle-reconcile`
 *
 * Vercel Cron invokes this with `GET` + `Authorization: Bearer $CRON_SECRET`;
 * `POST` is kept for manual/dev invocation. Auth: `requireCronAuth`.
 *
 * Hourly safety net for credit cycle grants:
 * - Scans paid workspaces (Stripe subscription status active/trialing)
 * - Computes current `cycleKey = ${stripeSubscriptionId}:${currentPeriodStartUnixSeconds}`
 * - Ensures a `cycle_grant_included` ledger entry exists (idempotent)
 *
 * Webhooks remain the primary mechanism. This cron is the backstop.
 *
 * The Free monthly floor pass that ran here until 2026-09-15 is gone with the floor itself:
 * Free is 100 starter credits once, then pay-as-you-go or Pro (`src/lib/billing/subscriptionState.ts`).
 */
import { NextResponse } from "next/server";
import Stripe from "stripe";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { CronHealthModel } from "@/lib/models/CronHealth";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { buildCycleKey, creditWindowIndex, grantCycleIncludedCredits } from "@/lib/credits/grants";
import { PRO_KIND_FILTER, isBillableStatus, isProSubscription } from "@/lib/billing/subscriptionState";
import { logErrorEvent, ERROR_CODE_CRON_JOB_FAILED } from "@/lib/errors/logger";
import { getSubscriptionPeriod } from "@/lib/billing/stripePeriods";
import { requireCronAuth } from "@/lib/cron/auth";

export const runtime = "nodejs";
export const maxDuration = 300;

function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
}

async function handle(request: Request) {
  const unauthorized = requireCronAuth(request);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);

  const startedAt = new Date();
  const jobKey = "credits-cycle-reconcile";
  const limit = Math.min(1000, asPositiveInt(url.searchParams.get("limit")) ?? 200);
  const staleHours = Math.min(72, asPositiveInt(url.searchParams.get("staleHours")) ?? 6);
  const dryRun = url.searchParams.get("dryRun") === "1";

  try {
    await connectMongo();
    await CronHealthModel.updateOne(
      { jobKey },
      {
        $set: {
          status: "running",
          lastStartedAt: startedAt,
          lastRunAt: startedAt,
          lastParams: { limit, staleHours, dryRun },
          lastError: null,
        },
      },
      { upsert: true },
    );
  } catch {
    // ignore
  }

  try {
    await connectMongo();

    // Pro only: a pay-as-you-go subscription is active in Stripe but has no included credits to grant.
    const candidates = await SubscriptionModel.find({
      isDeleted: { $ne: true },
      status: { $in: ["active", "trialing"] },
      ...PRO_KIND_FILTER,
      stripeSubscriptionId: { $ne: null },
    })
      .select({ _id: 1, orgId: 1, stripeSubscriptionId: 1, status: 1, kind: 1, currentPeriodStart: 1, currentPeriodEnd: 1, updatedDate: 1 })
      // Stalest stored period end first (nulls first), so a missed renewal is reached even past `limit`.
      .sort({ currentPeriodEnd: 1, _id: 1 })
      .limit(limit)
      .lean();

    const now = Date.now();
    const staleCutoffMs = staleHours * 60 * 60 * 1000;

    let checked = 0;
    let fetchedFromStripe = 0;
    let updatedSubscription = 0;
    let grantsApplied = 0;
    let grantsSkipped = 0;
    let errors = 0;

    const stripeKey = (process.env.STRIPE_SECRET_KEY ?? "").trim();
    const stripe = stripeKey ? new Stripe(stripeKey) : null;

    // Pre-compute cycleKeys for those with fresh stored period boundaries, then batch-check existing grants.
    const ready: Array<{ orgId: Types.ObjectId; subId: string; cycleKey: string; start: Date; end: Date }> = [];
    const needsStripe: Array<{ id: string; orgId: Types.ObjectId; subId: string }> = [];

    for (const s of candidates) {
      const subId = typeof (s as any)?.stripeSubscriptionId === "string" ? String((s as any).stripeSubscriptionId).trim() : "";
      const orgId = (s as any)?.orgId instanceof Types.ObjectId ? (s as any).orgId : null;
      if (!subId || !orgId) continue;

      if (!isProSubscription(s as { status?: unknown; kind?: unknown })) continue;

      const start = (s as any)?.currentPeriodStart instanceof Date ? (s as any).currentPeriodStart : null;
      const end = (s as any)?.currentPeriodEnd instanceof Date ? (s as any).currentPeriodEnd : null;
      const updatedAt = (s as any)?.updatedDate instanceof Date ? (s as any).updatedDate.getTime() : 0;
      const freshEnough = start && end && updatedAt && now - updatedAt < staleCutoffMs;

      if (freshEnough) {
        // Same window the grant will use, or the "already granted?" probe below answers about
        // month 0 and every later month of an annual period looks done.
        const cycleKey = buildCycleKey({
          stripeSubscriptionId: subId,
          currentPeriodStart: start!,
          monthIndex: creditWindowIndex(start!, end!, new Date()),
        });
        ready.push({ orgId, subId, cycleKey, start: start!, end: end! });
      } else {
        needsStripe.push({ id: String((s as any)._id), orgId, subId });
      }
    }

    // Batch-check: which ready cycle grants already exist?
    const existingSet = new Set<string>();
    if (ready.length) {
      const or = ready.map((r) => ({ workspaceId: r.orgId, eventType: "cycle_grant_included", cycleKey: r.cycleKey }));
      const existing = await CreditLedgerModel.find({ $or: or as any })
        .select({ workspaceId: 1, cycleKey: 1 })
        .lean();
      for (const e of existing) {
        existingSet.add(`${String((e as any).workspaceId)}|${String((e as any).cycleKey)}`);
      }
    }

    // Apply grants for ready set.
    for (const r of ready) {
      checked += 1;
      const key = `${String(r.orgId)}|${r.cycleKey}`;
      if (existingSet.has(key)) {
        grantsSkipped += 1;
        continue;
      }
      if (dryRun) {
        grantsApplied += 1; // would apply
        continue;
      }
      const res = await grantCycleIncludedCredits({
        workspaceId: String(r.orgId),
        stripeSubscriptionId: r.subId,
        currentPeriodStart: r.start,
        currentPeriodEnd: r.end,
        // On an annual plan this is what opens months 2..12: Stripe sends no event between
        // renewals, so without it a yearly subscriber would get one grant for the whole year.
        monthIndex: creditWindowIndex(r.start, r.end, new Date()),
      });
      if (res.alreadyGranted) grantsSkipped += 1;
      else grantsApplied += 1;
    }

    // Stripe fetch path (best-effort; requires STRIPE_SECRET_KEY).
    for (const row of needsStripe) {
      checked += 1;
      if (!stripe) {
        errors += 1;
        continue;
      }

      try {
        fetchedFromStripe += 1;
        const fresh = await stripe.subscriptions.retrieve(row.subId);
        // stripe@20 (API 2025-12-15) reports the period on subscription items, not the top level.
        const { start, end } = getSubscriptionPeriod(fresh);
        const status = typeof fresh.status === "string" ? fresh.status : "";

        /**
         * Write what Stripe just told us, before deciding whether to grant.
         *
         * This used to happen far below, after `!isBillableStatus` and after the already-granted
         * check — both of which `continue`. So the two cases where the stored row is most likely to
         * be wrong were exactly the two where the fresh answer was discarded: a subscription
         * Stripe had moved to `canceled` kept saying `active` for ever, and a row whose grant was
         * already applied never had its period refreshed even though we had just paid for the API
         * call. Reconciling is the whole job; throwing away the truth on the quiet paths is not a
         * saving.
         */
        if (!dryRun) {
          const patch: Record<string, unknown> = { status: status || "active" };
          if (start && end) {
            patch.currentPeriodStart = start;
            patch.currentPeriodEnd = end;
          }
          await SubscriptionModel.updateOne({ _id: new Types.ObjectId(row.id) }, { $set: patch });
          updatedSubscription += 1;
        }

        if (!start || !end) continue;
        if (!isBillableStatus(status)) continue;

        const cycleKey = buildCycleKey({
          stripeSubscriptionId: row.subId,
          currentPeriodStart: start,
          monthIndex: creditWindowIndex(start, end, new Date()),
        });
        const exists = await CreditLedgerModel.exists({
          workspaceId: row.orgId,
          eventType: "cycle_grant_included",
          cycleKey,
        });
        if (exists) {
          grantsSkipped += 1;
          continue;
        }
        if (dryRun) {
          grantsApplied += 1; // would apply
          continue;
        }

        const res = await grantCycleIncludedCredits({
          workspaceId: String(row.orgId),
          stripeSubscriptionId: row.subId,
          currentPeriodStart: start,
          currentPeriodEnd: end,
          monthIndex: creditWindowIndex(start, end, new Date()),
        });
        if (res.alreadyGranted) grantsSkipped += 1;
        else grantsApplied += 1;
      } catch {
        errors += 1;
      }
    }

    const finishedAt = new Date();
    const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
    const result = { checked, fetchedFromStripe, updatedSubscription, grantsApplied, grantsSkipped, errors, limit, dryRun };

    // Item-level failures record `error` so /api/monitor/crons alerts; the response stays 200.
    const failure = errors > 0 ? `${errors} of ${checked} subscriptions failed` : null;
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
      meta: { jobKey, params: { limit, staleHours }, durationMs },
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
  }
}

/** Vercel Cron entrypoint. */
export const GET = handle;
/** Manual/dev entrypoint. */
export const POST = handle;
