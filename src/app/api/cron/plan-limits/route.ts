/**
 * Cron route: `GET|POST /api/cron/plan-limits`
 *
 * Advances the plan-limit grace period for Free workspaces that are over a Free limit
 * (start grace → day 7 / day 12 reminders → block after `LIMIT_GRACE_DAYS`), clears grace
 * when a workspace drops back under the limits or upgrades to Pro, and emails workspace owners
 * at each step. See `src/lib/billing/planGrace.ts` and `docs/CRON.md`.
 *
 * Vercel Cron invokes this with `GET` + `Authorization: Bearer $CRON_SECRET`;
 * `POST` is kept for manual/dev invocation. Auth: `requireCronAuth`.
 *
 * Overlap protection: holds a `CronHealth` lease (`plan-limits`) so a slow run cannot overlap
 * the next hourly tick. Returns `{ skipped: "locked" }` with 200 when another run holds it.
 *
 * Query params:
 * - `limit=N`   max workspaces scanned per run (default 500, max 5000)
 * - `dryRun=1`  compute and count transitions without writing or sending
 */
import { NextResponse } from "next/server";

import { connectMongo } from "@/lib/mongodb";
import { CronHealthModel } from "@/lib/models/CronHealth";
import { logErrorEvent, ERROR_CODE_CRON_JOB_FAILED } from "@/lib/errors/logger";
import { requireCronAuth } from "@/lib/cron/auth";
import { acquireCronLease, releaseCronLease } from "@/lib/cron/lease";
import { runPlanLimitsGraceSweep } from "@/lib/billing/planGrace";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Lease TTL: slightly above `maxDuration` so a crashed run auto-expires. */
const LEASE_TTL_MS = 6 * 60 * 1000;

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

  const url = new URL(request.url);
  const jobKey = "plan-limits";
  const startedAt = new Date();

  const dryRun = url.searchParams.get("dryRun") === "1";
  const limit = Math.min(5000, asPositiveInt(url.searchParams.get("limit")) ?? 500);

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
          lastParams: { dryRun, limit },
          lastError: null,
        },
      },
      { upsert: true },
    );
  } catch {
    // ignore
  }

  try {
    const result = await runPlanLimitsGraceSweep({ now: startedAt, dryRun, limit });

    const finishedAt = new Date();
    const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
    // Failed emails/activity writes record `error` so /api/monitor/crons alerts; the response stays 200.
    const failure = result.errors > 0 ? `${result.errors} grace email or activity writes failed` : null;
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
  } finally {
    await releaseCronLease(lease);
  }
}

/** Vercel Cron entrypoint. */
export const GET = handle;
/** Manual/dev entrypoint. */
export const POST = handle;
