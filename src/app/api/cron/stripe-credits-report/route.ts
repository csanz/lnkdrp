/**
 * Cron route: `GET|POST /api/cron/stripe-credits-report`
 *
 * Reports metered AI credit usage (on-demand/overage only) to Stripe Billing Meters for Pro workspaces.
 *
 * Vercel Cron invokes this with `GET` + `Authorization: Bearer $CRON_SECRET`;
 * `POST` is kept for manual/dev invocation. Auth: `requireCronAuth`.
 *
 * Stripe API 2025-12-15 (stripe@20) removed `subscriptionItems.createUsageRecord`; usage is now sent as
 * meter events: `stripe.billing.meterEvents.create({ event_name, payload: { stripe_customer_id, value } })`.
 * The meter (`STRIPE_CREDITS_METER_EVENT_NAME`, default `ai_credits`) must be attached to the metered
 * price `STRIPE_AI_CREDITS_PRICE_ID` in the Stripe dashboard.
 *
 * Claim-then-report (crash/retry safe):
 * 0. REPLAY: rows still carrying a claim (`reportBatchId`) older than 30 minutes but never marked
 *    reported come from a run that crashed between REPORT and MARK (or between CLAIM and REPORT).
 *    They are re-sent grouped by their **stored** `reportBatchId` (same meter event `identifier`, so
 *    Stripe de-duplicates within its 24h window) and then marked. They are never re-batched with
 *    other rows: a different batch id would be a new identifier and double-bill the credits.
 * 1. CLAIM: `$set { reportBatchId, reportClaimedAt }` on eligible **unclaimed** ledger rows
 *    (`status="charged"`, `eventType="ai_run"`, `stripeUsageReportedAt=null`, `reportBatchId=null`).
 * 2. REPORT: one meter event per Stripe customer, using `reportBatchId` as the meter event `identifier`.
 * 3. MARK: `$set { stripeUsageReportedAt }` on the claimed rows.
 *
 * Overlap protection: holds a `CronHealth` lease for the duration of the run and returns
 * `{ skipped: "locked" }` (200) when another run is in progress.
 */
import { NextResponse } from "next/server";
import Stripe from "stripe";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { debugError, debugLog } from "@/lib/debug";
import { CronHealthModel } from "@/lib/models/CronHealth";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { SubscriptionModel } from "@/lib/models/Subscription";
import {
  batchIdempotencyKey,
  buildMeterEventParams,
  getCreditsMeterEventName,
  groupClaimedLedgersByBatch,
  groupOnDemandLedgersForStripe,
  REPORT_CLAIM_TTL_MS,
} from "@/lib/credits/stripeReporting";
import { requireCronAuth } from "@/lib/cron/auth";
import { acquireCronLease, releaseCronLease } from "@/lib/cron/lease";
import { logErrorEvent, ERROR_CODE_CRON_JOB_FAILED } from "@/lib/errors/logger";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Lease TTL: slightly above `maxDuration` so a crashed run auto-expires. */
const LEASE_TTL_MS = 6 * 60 * 1000;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

type RunResult = { processed: number; reported: number; batches: number; replayed: number; replayedBatches: number };

/**
 * Return whether a Stripe error says the meter event `identifier` was already used
 * (i.e. the event reached Stripe on a previous attempt and only our MARK step failed).
 */
function isDuplicateMeterIdentifierError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : "";
  const message = typeof e?.message === "string" ? e.message : "";
  if (code === "meter_event_identifier_already_used") return true;
  return /identifier/i.test(message) && /(already|duplicate|unique)/i.test(message);
}

/**
 * Shared handler for GET (Vercel Cron) and POST (manual) invocations.
 */
async function handle(request: Request) {
  const unauthorized = requireCronAuth(request);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const startedAt = new Date();
  const jobKey = "stripe-credits-report";
  // Pull a bounded batch for safety.
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(url.searchParams.get("limit") ?? "") || DEFAULT_LIMIT));

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
    const eventName = getCreditsMeterEventName();

    await connectMongo();

    // Map workspace → Stripe customer (only report for active Pro subscriptions with a known metered item).
    const subs = await SubscriptionModel.find({
      isDeleted: { $ne: true },
      status: { $in: ["active", "trialing"] },
      stripeSubscriptionItemId: { $ne: null },
      stripeCustomerId: { $ne: null },
    })
      .select({ orgId: 1, stripeCustomerId: 1 })
      .lean();
    const customerByWorkspace = new Map<string, string>();
    const workspaceObjectIds: Types.ObjectId[] = [];
    for (const s of subs) {
      const orgId = (s as any)?.orgId ? String((s as any).orgId) : "";
      const customerId =
        typeof (s as any)?.stripeCustomerId === "string" ? String((s as any).stripeCustomerId).trim() : "";
      if (!orgId || !customerId || !Types.ObjectId.isValid(orgId)) continue;
      customerByWorkspace.set(orgId, customerId);
      workspaceObjectIds.push(new Types.ObjectId(orgId));
    }

    const result: RunResult = { processed: 0, reported: 0, batches: 0, replayed: 0, replayedBatches: 0 };

    if (!workspaceObjectIds.length) {
      await markCronOk({ jobKey, startedAt, result });
      return NextResponse.json({ ok: true, ...result });
    }

    // IMPORTANT: Stripe metered billing should reflect only overage/on-demand usage (not included credits).
    const now = new Date();
    const nowTs = Math.floor(now.getTime() / 1000);
    const staleClaimBefore = new Date(now.getTime() - REPORT_CLAIM_TTL_MS);
    const baseFilter = {
      workspaceId: { $in: workspaceObjectIds as any },
      status: "charged",
      eventType: "ai_run",
      stripeUsageReportedAt: null,
      creditsFromOnDemand: { $gt: 0 },
    };

    /** Send one meter event for a batch; returns `true` when Stripe has it (sent now or already). */
    const sendBatch = async (p: { stripeCustomerId: string; reportBatchId: string; credits: number }): Promise<boolean> => {
      try {
        await stripe.billing.meterEvents.create(
          buildMeterEventParams({
            eventName,
            stripeCustomerId: p.stripeCustomerId,
            credits: p.credits,
            identifier: p.reportBatchId,
            timestampUnixSeconds: nowTs,
          }),
          { idempotencyKey: p.reportBatchId },
        );
        return true;
      } catch (err) {
        if (isDuplicateMeterIdentifierError(err)) return true;
        throw err;
      }
    };

    // 0) REPLAY stale claims under their stored batch id (see module docs).
    const stale = await CreditLedgerModel.find({
      ...baseFilter,
      reportBatchId: { $ne: null },
      $or: [{ reportClaimedAt: null }, { reportClaimedAt: { $lt: staleClaimBefore } }],
    })
      .select({ _id: 1, workspaceId: 1, creditsFromOnDemand: 1, reportBatchId: 1 })
      .sort({ reportClaimedAt: 1 })
      .limit(limit)
      .lean();

    if (stale.length) {
      const staleGroups = groupClaimedLedgersByBatch({
        ledgers: stale.map((l) => ({
          id: String((l as any)._id),
          workspaceId: String((l as any).workspaceId),
          creditsFromOnDemand: typeof (l as any).creditsFromOnDemand === "number" ? (l as any).creditsFromOnDemand : 0,
          reportBatchId: String((l as any).reportBatchId ?? ""),
        })),
        stripeCustomerIdByWorkspaceId: customerByWorkspace,
      });

      for (const [reportBatchId, b] of staleGroups.entries()) {
        if (!b.ledgerIds.length) continue;
        const ledgerObjectIds = b.ledgerIds.map((id) => new Types.ObjectId(id));

        // Re-claim (refresh `reportClaimedAt`) so a concurrent run cannot replay the same batch.
        const reclaim = await CreditLedgerModel.updateMany(
          {
            _id: { $in: ledgerObjectIds as any },
            reportBatchId,
            stripeUsageReportedAt: null,
            $or: [{ reportClaimedAt: null }, { reportClaimedAt: { $lt: staleClaimBefore } }],
          },
          { $set: { reportClaimedAt: now } },
        );
        const reclaimed = Number((reclaim as any)?.modifiedCount ?? 0);
        if (reclaimed !== b.ledgerIds.length) {
          debugLog(2, "[cron:stripe-credits-report] replay skipped (concurrent claim)", {
            reportBatchId,
            expected: b.ledgerIds.length,
            reclaimed,
          });
          continue;
        }

        try {
          if (b.quantity > 0) {
            await sendBatch({ stripeCustomerId: b.stripeCustomerId, reportBatchId, credits: b.quantity });
          }
          await CreditLedgerModel.updateMany(
            { _id: { $in: ledgerObjectIds as any }, reportBatchId },
            { $set: { stripeUsageReportedAt: new Date() } },
          );
          result.replayed += b.ledgerIds.length;
          result.replayedBatches += 1;
          debugLog(1, "[cron:stripe-credits-report] stale batch replayed", {
            stripeCustomerId: b.stripeCustomerId,
            reportBatchId,
            credits: b.quantity,
            ledgers: b.ledgerIds.length,
          });
        } catch (err) {
          // Leave the claim in place: the rows stay tied to this batch id and are replayed next run.
          debugError(1, "[cron:stripe-credits-report] stale batch replay failed", {
            reportBatchId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // 1) Fresh rows: only rows that have never been claimed (stale claims are handled above).
    const ledgers = await CreditLedgerModel.find({ ...baseFilter, reportBatchId: null })
      .select({ _id: 1, workspaceId: 1, creditsFromOnDemand: 1 })
      .sort({ createdDate: 1 })
      .limit(limit)
      .lean();
    result.processed = ledgers.length;

    if (!ledgers.length) {
      await markCronOk({ jobKey, startedAt, result });
      return NextResponse.json({ ok: true, ...result });
    }

    // Group by Stripe customer id (meter events are keyed by customer).
    const grouped = groupOnDemandLedgersForStripe({
      ledgers: ledgers.map((l) => ({
        id: String((l as any)._id),
        workspaceId: String((l as any).workspaceId),
        creditsFromOnDemand: typeof (l as any).creditsFromOnDemand === "number" ? (l as any).creditsFromOnDemand : 0,
      })),
      stripeCustomerIdByWorkspaceId: customerByWorkspace,
    });

    for (const [stripeCustomerId, b] of grouped.entries()) {
      if (b.quantity <= 0 || !b.ledgerIds.length) continue;
      const ledgerObjectIds = b.ledgerIds.map((id) => new Types.ObjectId(id));
      const reportBatchId = batchIdempotencyKey({ stripeCustomerId, ledgerIds: b.ledgerIds });

      // CLAIM: only rows still unclaimed and unreported.
      const claim = await CreditLedgerModel.updateMany(
        { _id: { $in: ledgerObjectIds as any }, stripeUsageReportedAt: null, reportBatchId: null },
        { $set: { reportBatchId, reportClaimedAt: now } },
      );
      const claimed = Number((claim as any)?.modifiedCount ?? 0);
      if (claimed !== b.ledgerIds.length) {
        // Another run claimed part of this batch concurrently. Reporting a partial batch under this
        // batch id would misstate the quantity; release our claim and let the next run rebuild batches.
        await CreditLedgerModel.updateMany(
          { _id: { $in: ledgerObjectIds as any }, reportBatchId, reportClaimedAt: now, stripeUsageReportedAt: null },
          { $set: { reportBatchId: null, reportClaimedAt: null } },
        );
        debugLog(2, "[cron:stripe-credits-report] batch skipped (concurrent claim)", {
          stripeCustomerId,
          expected: b.ledgerIds.length,
          claimed,
        });
        continue;
      }

      // REPORT: identifier = batch id → Stripe de-duplicates a re-sent batch.
      await sendBatch({ stripeCustomerId, reportBatchId, credits: b.quantity });

      // MARK reported.
      await CreditLedgerModel.updateMany(
        { _id: { $in: ledgerObjectIds as any }, reportBatchId },
        { $set: { stripeUsageReportedAt: new Date() } },
      );
      result.reported += b.ledgerIds.length;
      result.batches += 1;
      debugLog(1, "[cron:stripe-credits-report] batch reported", {
        stripeCustomerId,
        reportBatchId,
        credits: b.quantity,
        ledgers: b.ledgerIds.length,
      });
    }

    await markCronOk({ jobKey, startedAt, result });
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

/** Persist a successful run to `CronHealth` (best-effort). */
async function markCronOk(params: { jobKey: string; startedAt: Date; result: Record<string, unknown> }): Promise<void> {
  const finishedAt = new Date();
  const durationMs = Math.max(0, finishedAt.getTime() - params.startedAt.getTime());
  try {
    await connectMongo();
    await CronHealthModel.updateOne(
      { jobKey: params.jobKey },
      {
        $set: {
          status: "ok",
          lastFinishedAt: finishedAt,
          lastRunAt: finishedAt,
          lastDurationMs: durationMs,
          lastResult: params.result,
        },
      },
      { upsert: true },
    );
  } catch {
    // ignore
  }
}

/** Vercel Cron entrypoint. */
export const GET = handle;
/** Manual/dev entrypoint. */
export const POST = handle;
