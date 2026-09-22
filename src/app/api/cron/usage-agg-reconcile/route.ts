/**
 * Cron route: `GET|POST /api/cron/usage-agg-reconcile`
 *
 * Recomputes usage aggregates from source-of-truth `CreditLedger` events for a date range.
 * Idempotent: overwrites deterministic totals via upserts (safe to re-run).
 *
 * Vercel Cron invokes this with `GET` + `Authorization: Bearer $CRON_SECRET`;
 * `POST` is kept for manual/dev invocation. Auth: `requireCronAuth`.
 */
import { refuseUnsupportedDryRun } from "@/lib/cron/dryRun";
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { CronHealthModel } from "@/lib/models/CronHealth";
import { reconcileUsageAggsFromLedger } from "@/lib/usage/reconcile";
import { logErrorEvent, ERROR_CODE_CRON_JOB_FAILED } from "@/lib/errors/logger";
import { requireCronAuth } from "@/lib/cron/auth";

export const runtime = "nodejs";
export const maxDuration = 300;

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function parseDayParam(v: string | null): Date | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  // Expect YYYY-MM-DD; interpret as UTC.
  const ms = Date.parse(`${s}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

function asPositiveInt(v: string | null): number | null {
  const n = Number(v);
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

  // This route has no dry-run mode; refuse the flag rather than do the real work.
  const noDryRun = refuseUnsupportedDryRun(request, "usage-agg-reconcile");
  if (noDryRun) return noDryRun;

  const url = new URL(request.url);
  const jobKey = "usage-agg-reconcile";
  const startedAt = new Date();

  // Params:
  // - start=YYYY-MM-DD (UTC)
  // - end=YYYY-MM-DD (UTC) inclusive (we convert to endExclusive)
  // - days=N (fallback; default 45)
  // - workspaceId=<ObjectId> optional
  const startParam = parseDayParam(url.searchParams.get("start"));
  const endParam = parseDayParam(url.searchParams.get("end"));
  const days = Math.min(365, asPositiveInt(url.searchParams.get("days")) ?? 45);
  const workspaceId = (url.searchParams.get("workspaceId") ?? "").trim() || null;
  if (workspaceId && !Types.ObjectId.isValid(workspaceId)) {
    return NextResponse.json({ error: "Invalid workspaceId" }, { status: 400 });
  }

  const endDay = endParam ? startOfUtcDay(endParam) : startOfUtcDay(new Date());
  const startDay = startParam
    ? startOfUtcDay(startParam)
    : (() => {
        const d = new Date(endDay);
        d.setUTCDate(d.getUTCDate() - (days - 1));
        return d;
      })();
  const endExclusive = (() => {
    const d = new Date(endDay);
    d.setUTCDate(d.getUTCDate() + 1);
    return d;
  })();

  try {
    await connectMongo();
    await CronHealthModel.updateOne(
      { jobKey },
      {
        $set: {
          status: "running",
          lastStartedAt: startedAt,
          lastRunAt: startedAt,
          lastParams: {
            start: startDay.toISOString().slice(0, 10),
            end: endDay.toISOString().slice(0, 10),
            days,
            workspaceId,
          },
          lastError: null,
        },
      },
      { upsert: true },
    );
  } catch {
    // ignore
  }

  try {
    const result = await reconcileUsageAggsFromLedger({
      startDay,
      endDayExclusive: endExclusive,
      workspaceId,
    });

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
            lastResult: result,
          },
        },
        { upsert: true },
      );
    } catch {
      // ignore
    }

    return NextResponse.json(result);
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

/** Vercel Cron entrypoint. */
export const GET = handle;
/** Manual/dev entrypoint. */
export const POST = handle;
