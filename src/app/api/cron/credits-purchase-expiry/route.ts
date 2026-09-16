/**
 * Cron route: `GET|POST /api/cron/credits-purchase-expiry`
 *
 * Takes back the unspent credits of prepaid packs bought 12 months ago (`expireCreditPurchases`).
 * Daily; idempotent (an expired purchase is never processed twice), so a missed or doubled run only
 * shifts an expiry by a day. `?limit=N` caps the workspaces handled in one run.
 *
 * Vercel Cron invokes this with `GET` + `Authorization: Bearer $CRON_SECRET`; `POST` is for manual
 * runs. Auth: `requireCronAuth`.
 */
import { NextResponse } from "next/server";

import { connectMongo } from "@/lib/mongodb";
import { CronHealthModel } from "@/lib/models/CronHealth";
import { expireCreditPurchases } from "@/lib/credits/purchases";
import { logErrorEvent, ERROR_CODE_CRON_JOB_FAILED } from "@/lib/errors/logger";
import { requireCronAuth } from "@/lib/cron/auth";

export const runtime = "nodejs";
export const maxDuration = 300;

const jobKey = "credits-purchase-expiry";

async function recordHealth(set: Record<string, unknown>) {
  try {
    await connectMongo();
    await CronHealthModel.updateOne({ jobKey }, { $set: set }, { upsert: true });
  } catch {
    // Health is best-effort; never fail the job over it.
  }
}

async function handle(request: Request) {
  const unauthorized = requireCronAuth(request);
  if (unauthorized) return unauthorized;
  const limitRaw = Number(new URL(request.url).searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw >= 1 ? Math.floor(limitRaw) : undefined;
  const startedAt = new Date();
  await recordHealth({ status: "running", lastStartedAt: startedAt, lastRunAt: startedAt, lastParams: { limit: limit ?? null }, lastError: null });

  try {
    const result = await expireCreditPurchases({ now: startedAt, limit });
    const finishedAt = new Date();
    await recordHealth({
      status: "ok",
      lastFinishedAt: finishedAt,
      lastRunAt: finishedAt,
      lastDurationMs: finishedAt.getTime() - startedAt.getTime(),
      lastResult: result,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const finishedAt = new Date();
    const message = err instanceof Error ? err.message : String(err);
    void logErrorEvent({
      severity: "error",
      category: "cron",
      code: ERROR_CODE_CRON_JOB_FAILED,
      err,
      request,
      statusCode: 500,
      meta: { jobKey, durationMs: finishedAt.getTime() - startedAt.getTime() },
    });
    await recordHealth({
      status: "error",
      lastFinishedAt: finishedAt,
      lastRunAt: finishedAt,
      lastDurationMs: finishedAt.getTime() - startedAt.getTime(),
      lastErrorAt: finishedAt,
      lastError: message,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Vercel Cron entrypoint. */
export const GET = handle;
/** Manual/dev entrypoint. */
export const POST = handle;
