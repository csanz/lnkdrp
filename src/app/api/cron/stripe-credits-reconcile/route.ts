/**
 * Cron route: `POST /api/cron/stripe-credits-reconcile`
 *
 * Backstop job for credit cycles:
 * - fetch active Stripe subscriptions
 * - sync currentPeriodStart/currentPeriodEnd onto our `Subscription` record
 * - ensure included credits reset/grant is applied once per cycleKey
 *
 * Auth: optional `LNKDRP_CRON_SECRET` (same as other cron routes).
 */
import { NextResponse } from "next/server";
import Stripe from "stripe";

import { connectMongo } from "@/lib/mongodb";
import { CronHealthModel } from "@/lib/models/CronHealth";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { grantCycleIncludedCredits, buildCycleKey } from "@/lib/credits/grants";
import { logErrorEvent, ERROR_CODE_CRON_JOB_FAILED } from "@/lib/errors/logger";

export const runtime = "nodejs";

function parseUnixSecondsToDateStrict(v: unknown): Date | null {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v * 1000);
  if (typeof v === "string") {
    const n = Number(v.trim());
    if (Number.isFinite(n)) return new Date(n * 1000);
  }
  return null;
}

function isProStatus(statusRaw: unknown): boolean {
  const s = typeof statusRaw === "string" ? statusRaw.trim().toLowerCase() : "";
  return s === "active" || s === "trialing";
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const secret = process.env.LNKDRP_CRON_SECRET;
  if (secret) {
    const provided =
      request.headers.get("x-cron-secret") ??
      request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      url.searchParams.get("secret");
    if (!provided || provided !== secret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const startedAt = new Date();
  const jobKey = "stripe-credits-reconcile";

  try {
    await connectMongo();
    await CronHealthModel.updateOne(
      { jobKey },
      {
        $set: {
          status: "running",
          lastStartedAt: startedAt,
          lastRunAt: startedAt,
          lastParams: {},
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
    const subs = await SubscriptionModel.find({
      isDeleted: { $ne: true },
      status: { $in: ["active", "trialing"] },
      stripeSubscriptionId: { $ne: null },
    })
      .select({ orgId: 1, stripeSubscriptionId: 1, currentPeriodStart: 1, currentPeriodEnd: 1, status: 1 })
      .lean();

    let processed = 0;
    let updated = 0;
    let granted = 0;

    for (const s of subs) {
      processed += 1;
      const subId = typeof (s as any)?.stripeSubscriptionId === "string" ? String((s as any).stripeSubscriptionId) : "";
      const orgId = (s as any)?.orgId ? String((s as any).orgId) : "";
      if (!subId || !orgId) continue;

      let fresh: Stripe.Subscription | null = null;
      try {
        fresh = await stripe.subscriptions.retrieve(subId);
      } catch {
        continue;
      }

      const status = typeof fresh.status === "string" ? fresh.status : "";
      const pro = isProStatus(status);
      const currentPeriodStart = parseUnixSecondsToDateStrict((fresh as any)?.current_period_start);
      const currentPeriodEnd = parseUnixSecondsToDateStrict((fresh as any)?.current_period_end);
      if (!currentPeriodStart || !currentPeriodEnd) continue;

      const prevStart = (s as any)?.currentPeriodStart instanceof Date ? (s as any).currentPeriodStart : null;
      const prevEnd = (s as any)?.currentPeriodEnd instanceof Date ? (s as any).currentPeriodEnd : null;

      const changed =
        !prevStart || prevStart.getTime() !== currentPeriodStart.getTime() || !prevEnd || prevEnd.getTime() !== currentPeriodEnd.getTime();

      if (changed) {
        await SubscriptionModel.updateOne(
          { _id: (s as any)._id },
          { $set: { status: status || (s as any).status, currentPeriodStart, currentPeriodEnd } },
        );
        updated += 1;
      }

      if (pro) {
        const cycleKey = buildCycleKey({ stripeSubscriptionId: subId, currentPeriodStart });
        const res = await grantCycleIncludedCredits({
          workspaceId: orgId,
          stripeSubscriptionId: subId,
          currentPeriodStart,
          currentPeriodEnd,
        });
        if (!res.alreadyGranted) granted += 1;
      }
    }

    const finishedAt = new Date();
    const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
    try {
      await connectMongo();
      await CronHealthModel.updateOne(
        { jobKey },
        {
          $set: {
            status: "ok",
            lastFinishedAt: finishedAt,
            lastRunAt: finishedAt,
            lastDurationMs: durationMs,
            lastResult: { processed, updated, granted },
          },
        },
        { upsert: true },
      );
    } catch {
      // ignore
    }

    return NextResponse.json({ ok: true, processed, updated, granted });
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
      meta: { jobKey, durationMs },
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


