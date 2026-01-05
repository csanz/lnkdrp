/**
 * Cron route: `POST /api/cron/credits-cycle-reconcile`
 *
 * Hourly safety net for credit cycle grants:
 * - Scans paid workspaces (Stripe subscription status active/trialing)
 * - Computes current `cycleKey = ${stripeSubscriptionId}:${currentPeriodStartUnixSeconds}`
 * - Ensures a `cycle_grant_included` ledger entry exists (idempotent)
 *
 * Webhooks remain the primary mechanism. This cron is the backstop.
 */
import { NextResponse } from "next/server";
import Stripe from "stripe";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { CronHealthModel } from "@/lib/models/CronHealth";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { buildCycleKey, grantCycleIncludedCredits } from "@/lib/credits/grants";
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

function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
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
  const jobKey = "credits-cycle-reconcile";
  const limit = Math.min(1000, asPositiveInt(url.searchParams.get("limit")) ?? 200);
  const staleHours = Math.min(72, asPositiveInt(url.searchParams.get("staleHours")) ?? 6);

  try {
    await connectMongo();
    await CronHealthModel.updateOne(
      { jobKey },
      {
        $set: {
          status: "running",
          lastStartedAt: startedAt,
          lastRunAt: startedAt,
          lastParams: { limit, staleHours },
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

    const candidates = await SubscriptionModel.find({
      isDeleted: { $ne: true },
      status: { $in: ["active", "trialing"] },
      stripeSubscriptionId: { $ne: null },
    })
      .select({ _id: 1, orgId: 1, stripeSubscriptionId: 1, status: 1, currentPeriodStart: 1, currentPeriodEnd: 1, updatedDate: 1 })
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

      const status = (s as any)?.status;
      if (!isProStatus(status)) continue;

      const start = (s as any)?.currentPeriodStart instanceof Date ? (s as any).currentPeriodStart : null;
      const end = (s as any)?.currentPeriodEnd instanceof Date ? (s as any).currentPeriodEnd : null;
      const updatedAt = (s as any)?.updatedDate instanceof Date ? (s as any).updatedDate.getTime() : 0;
      const freshEnough = start && end && updatedAt && now - updatedAt < staleCutoffMs;

      if (freshEnough) {
        const cycleKey = buildCycleKey({ stripeSubscriptionId: subId, currentPeriodStart: start! });
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
      const res = await grantCycleIncludedCredits({
        workspaceId: String(r.orgId),
        stripeSubscriptionId: r.subId,
        currentPeriodStart: r.start,
        currentPeriodEnd: r.end,
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
        const start = parseUnixSecondsToDateStrict((fresh as any)?.current_period_start);
        const end = parseUnixSecondsToDateStrict((fresh as any)?.current_period_end);
        const status = typeof fresh.status === "string" ? fresh.status : "";
        if (!start || !end) continue;
        if (!isProStatus(status)) continue;

        const cycleKey = buildCycleKey({ stripeSubscriptionId: row.subId, currentPeriodStart: start });
        const exists = await CreditLedgerModel.exists({
          workspaceId: row.orgId,
          eventType: "cycle_grant_included",
          cycleKey,
        });
        if (exists) {
          grantsSkipped += 1;
          continue;
        }

        // Keep subscription period fields fresh as a side effect (helps snapshot correctness).
        await SubscriptionModel.updateOne(
          { _id: new Types.ObjectId(row.id) },
          { $set: { status: status || "active", currentPeriodStart: start, currentPeriodEnd: end } },
        );
        updatedSubscription += 1;

        const res = await grantCycleIncludedCredits({
          workspaceId: String(row.orgId),
          stripeSubscriptionId: row.subId,
          currentPeriodStart: start,
          currentPeriodEnd: end,
        });
        if (res.alreadyGranted) grantsSkipped += 1;
        else grantsApplied += 1;
      } catch {
        errors += 1;
      }
    }

    const finishedAt = new Date();
    const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
    const result = { checked, fetchedFromStripe, updatedSubscription, grantsApplied, grantsSkipped, errors, limit };

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
            lastResult: result,
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


