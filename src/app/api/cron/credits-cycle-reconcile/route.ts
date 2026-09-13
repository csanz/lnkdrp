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
 * Free monthly floor pass (`grantFreeMonthlyFloor`): scans balance rows not yet evaluated for the
 * current UTC month (`freeFloorMonth`), tops personal Free workspaces up to the floor, marks
 * Pro/team rows as evaluated, and re-queues skipped summaries for workspaces that received credits.
 * The reserve path and the dashboard snapshot apply the same floor on read; this covers workspaces
 * that are idle on the first of the month.
 *
 * Query params: `limit` (per pass, default 200, max 1000), `staleHours`, `dryRun=1` (count only:
 * no grants, no marks, no subscription updates, no re-queues).
 */
import { NextResponse } from "next/server";
import Stripe from "stripe";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { CronHealthModel } from "@/lib/models/CronHealth";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { OrgModel } from "@/lib/models/Org";
import { WorkspaceCreditBalanceModel } from "@/lib/models/WorkspaceCreditBalance";
import {
  FREE_MONTHLY_FLOOR_CREDITS,
  buildCycleKey,
  freeFloorMonth,
  grantCycleIncludedCredits,
  grantFreeMonthlyFloor,
} from "@/lib/credits/grants";
import { requeueSkippedSummaries } from "@/lib/credits/summaryRequeue";
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

function isProStatus(statusRaw: unknown): boolean {
  const s = typeof statusRaw === "string" ? statusRaw.trim().toLowerCase() : "";
  return s === "active" || s === "trialing";
}

type FreeFloorPassResult = {
  month: string;
  /** Balance rows not yet evaluated for `month` (bounded by `limit`). */
  scanned: number;
  /** Personal workspaces without an active/trialing subscription. */
  eligible: number;
  /** Eligible workspaces whose month this pass claimed. */
  applied: number;
  /** Workspaces that actually received credits (balance was below the floor). */
  toppedUp: number;
  creditsAdded: number;
  /** dryRun only: eligible workspaces currently below the floor. */
  wouldTopUp: number;
  /** Pro/team rows marked as evaluated for `month` (no credits). */
  markedIneligible: number;
  requeuedSummaries: number;
  errors: number;
};

/**
 * Free monthly floor pass. Bounded by `limit`; ineligible rows are marked so the scan advances.
 */
async function runFreeFloorPass(params: { now: Date; limit: number; dryRun: boolean; origin: string }): Promise<FreeFloorPassResult> {
  const month = freeFloorMonth(params.now);
  const out: FreeFloorPassResult = {
    month,
    scanned: 0,
    eligible: 0,
    applied: 0,
    toppedUp: 0,
    creditsAdded: 0,
    wouldTopUp: 0,
    markedIneligible: 0,
    requeuedSummaries: 0,
    errors: 0,
  };

  const rows = (await WorkspaceCreditBalanceModel.find({ freeFloorMonth: { $ne: month } })
    .select({ _id: 0, workspaceId: 1, trialCreditsRemaining: 1 })
    .limit(params.limit)
    .lean()) as Array<{ workspaceId?: unknown; trialCreditsRemaining?: unknown }>;
  const candidates = rows.filter((r): r is { workspaceId: Types.ObjectId; trialCreditsRemaining?: unknown } => r.workspaceId instanceof Types.ObjectId);
  out.scanned = candidates.length;
  if (!candidates.length) return out;

  const ids = candidates.map((r) => r.workspaceId);
  const [personalOrgs, proSubs] = await Promise.all([
    OrgModel.find({ _id: { $in: ids }, type: "personal", isDeleted: { $ne: true } }).select({ _id: 1 }).lean(),
    SubscriptionModel.find({ orgId: { $in: ids }, isDeleted: { $ne: true }, status: { $in: ["active", "trialing"] } })
      .select({ orgId: 1 })
      .lean(),
  ]);
  const personal = new Set(personalOrgs.map((o) => String((o as { _id: unknown })._id)));
  const pro = new Set(proSubs.map((sub) => String((sub as { orgId: unknown }).orgId)));

  const eligible = candidates.filter((r) => personal.has(String(r.workspaceId)) && !pro.has(String(r.workspaceId)));
  const ineligibleIds = candidates.filter((r) => !eligible.includes(r)).map((r) => r.workspaceId);
  out.eligible = eligible.length;

  if (params.dryRun) {
    out.wouldTopUp = eligible.filter((r) => {
      const n = Number(r.trialCreditsRemaining ?? 0);
      return !Number.isFinite(n) || n < FREE_MONTHLY_FLOOR_CREDITS;
    }).length;
    return out;
  }

  if (ineligibleIds.length) {
    try {
      const res = await WorkspaceCreditBalanceModel.updateMany(
        { workspaceId: { $in: ineligibleIds }, freeFloorMonth: { $ne: month } },
        { $set: { freeFloorMonth: month } },
      );
      out.markedIneligible = res.modifiedCount ?? 0;
    } catch {
      out.errors += 1;
    }
  }

  for (const r of eligible) {
    const orgId = String(r.workspaceId);
    try {
      // Re-checks plan facts itself, so a workspace that upgraded since the scan is only marked.
      const res = await grantFreeMonthlyFloor({ workspaceId: orgId, now: params.now });
      if (res.applied) out.applied += 1;
      if (res.creditsAdded > 0) {
        out.toppedUp += 1;
        out.creditsAdded += res.creditsAdded;
        try {
          const { queued } = await requeueSkippedSummaries({ orgId, origin: params.origin, limit: 10 });
          out.requeuedSummaries += queued;
        } catch {
          out.errors += 1;
        }
      }
    } catch {
      out.errors += 1;
    }
  }
  return out;
}

/**
 * Shared handler for GET (Vercel Cron) and POST (manual) invocations.
 */
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
      if (dryRun) {
        grantsApplied += 1; // would apply
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
        // stripe@20 (API 2025-12-15) reports the period on subscription items, not the top level.
        const { start, end } = getSubscriptionPeriod(fresh);
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
        if (dryRun) {
          grantsApplied += 1; // would apply
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

    let freeFloor: FreeFloorPassResult | { error: string };
    try {
      freeFloor = await runFreeFloorPass({ now: new Date(), limit, dryRun, origin: url.origin });
    } catch (e) {
      freeFloor = { error: e instanceof Error ? e.message : String(e) };
    }

    const finishedAt = new Date();
    const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
    const result = { checked, fetchedFromStripe, updatedSubscription, grantsApplied, grantsSkipped, errors, limit, dryRun, freeFloor };

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

/** Vercel Cron entrypoint. */
export const GET = handle;
/** Manual/dev entrypoint. */
export const POST = handle;
