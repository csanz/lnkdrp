/**
 * Cron route: `GET|POST /api/cron/visit-briefs`
 *
 * Closes recipient visits that have gone quiet and writes them up (docs/prds/lnkdrp-visit-briefs.md).
 * Every stats ingest leaves a `VisitBrief` row with a `dueAt`; this tick claims the due ones,
 * checks the visit really is over, writes the brief (one credit, Pro workspaces with automatic
 * briefs on), stores it, records the feed row, enqueues one `visit_briefs` email per member and
 * sends those in the same tick. The `notification-emails` cron is the backstop for any it leaves.
 *
 * The body is one call into `src/lib/visits/visitBriefs.ts`; a queue worker replaces this route by
 * calling the same functions, which is the point of keeping nothing here.
 *
 * Vercel sends `GET` + `Authorization: Bearer $CRON_SECRET`; `POST` is kept for manual runs.
 * `?dryRun=1` claims nothing and writes nothing. Overlap protection: a `CronHealth` lease.
 */
import { NextResponse } from "next/server";
import { connectMongo } from "@/lib/mongodb";
import { writeCronHealth } from "@/lib/cron/health";
import { logErrorEvent, ERROR_CODE_CRON_JOB_FAILED } from "@/lib/errors/logger";
import { runVisitBriefs } from "@/lib/visits/visitBriefs";
import { requireCronAuth } from "@/lib/cron/auth";
import { acquireCronLease, releaseCronLease } from "@/lib/cron/lease";

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

async function handle(request: Request) {
  const unauthorized = requireCronAuth(request);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const jobKey = "visit-briefs";
  const startedAt = new Date();

  const dryRun = url.searchParams.get("dryRun") === "1";
  const workspaceId = (url.searchParams.get("workspaceId") ?? "").trim() || null;
  const limit = asPositiveInt(url.searchParams.get("limit"));

  const lease = await acquireCronLease({ jobKey, ttlMs: LEASE_TTL_MS });
  if (!lease) {
    return NextResponse.json({ ok: true, skipped: "locked", jobKey });
  }

  try {
    await connectMongo();
    await writeCronHealth(
      jobKey,
      {
        status: "running",
        lastStartedAt: startedAt,
        lastRunAt: startedAt,
        lastParams: { dryRun, workspaceId, limit },
        lastError: null,
      },
      { dryRun },
    );
  } catch {
    // ignore
  }

  try {
    const result = await runVisitBriefs({
      dryRun,
      workspaceId,
      ...(limit ? { limit } : {}),
    });

    const finishedAt = new Date();
    const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());

    // Only what a person must act on flips the light: rows that gave up on the model (the recap
    // went out, the credit was refunded, but something is wrong with the run), and settles that
    // threw outright. A model retry is not an alarm.
    const problems: string[] = [];
    if (result.failed > 0) problems.push(`${result.failed} brief${result.failed === 1 ? "" : "s"} failed every model attempt`);
    if (result.errors > 0) problems.push(`${result.errors} visit${result.errors === 1 ? "" : "s"} could not be settled`);

    try {
      await connectMongo();
      await writeCronHealth(
        jobKey,
        {
          status: problems.length ? "error" : "ok",
          lastFinishedAt: finishedAt,
          lastRunAt: finishedAt,
          lastDurationMs: durationMs,
          lastResult: result,
          ...(problems.length ? { lastErrorAt: finishedAt, lastError: problems.join("; ") } : {}),
          ...(result.retried > 0 && !problems.length ? { lastError: `${result.retried} brief(s) will retry` } : {}),
        },
        { dryRun },
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
      await writeCronHealth(
        jobKey,
        {
          status: "error",
          lastFinishedAt: finishedAt,
          lastRunAt: finishedAt,
          lastDurationMs: durationMs,
          lastErrorAt: finishedAt,
          lastError: message,
        },
        { dryRun },
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
