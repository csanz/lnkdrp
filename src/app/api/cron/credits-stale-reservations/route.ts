/**
 * Cron route: `GET|POST /api/cron/credits-stale-reservations`
 *
 * Gives back credits reserved for an AI run that died before it could settle
 * (`releaseStaleReservations`). Hourly; idempotent — the refund re-reads each row in a transaction
 * and does nothing unless it is still `pending`, so a doubled run cannot refund twice and a missed
 * one only delays a release by an hour.
 *
 * `?limit=N` caps the rows handled in one run (default 500, oldest first). `?olderThanMs=N` lowers
 * the cutoff for a manual sweep; it defaults to the same hour the admin anomaly page uses to call a
 * reservation lost. `?dryRun=1` reports exactly what it would release and writes nothing.
 *
 * Vercel Cron invokes this with `GET` + `Authorization: Bearer $CRON_SECRET`; `POST` is for manual
 * runs. Auth: `requireCronAuth`.
 */
import { NextResponse } from "next/server";

import { connectMongo } from "@/lib/mongodb";
import { CronHealthModel } from "@/lib/models/CronHealth";
import { releaseStaleReservations } from "@/lib/credits/staleReservations";
import { logErrorEvent, ERROR_CODE_CRON_JOB_FAILED } from "@/lib/errors/logger";
import { requireCronAuth } from "@/lib/cron/auth";

export const runtime = "nodejs";
export const maxDuration = 300;

const jobKey = "credits-stale-reservations";

async function recordHealth(set: Record<string, unknown>) {
  try {
    await connectMongo();
    await CronHealthModel.updateOne({ jobKey }, { $set: set }, { upsert: true });
  } catch {
    // Health is best-effort; never fail the job over it.
  }
}

function intParam(url: URL, name: string): number | undefined {
  const raw = Number(url.searchParams.get(name));
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : undefined;
}

async function handle(request: Request) {
  const unauthorized = requireCronAuth(request);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const limit = intParam(url, "limit");
  const olderThanMs = intParam(url, "olderThanMs");
  // Real support, so this route implements the flag rather than refusing it: the sweep reads the
  // rows it would release and reports them, and writes nothing.
  const dryRunRaw = url.searchParams.get("dryRun");
  const dryRun = dryRunRaw === "1" || dryRunRaw === "true";

  const startedAt = new Date();
  // A dry run must not look like a real one in the health record, or the next reader believes
  // credits were returned when nothing was.
  await recordHealth({
    status: "running",
    lastStartedAt: startedAt,
    lastRunAt: startedAt,
    lastParams: { limit: limit ?? null, olderThanMs: olderThanMs ?? null, dryRun },
    lastError: null,
  });

  try {
    const result = await releaseStaleReservations({ now: startedAt, limit, olderThanMs, dryRun });
    const finishedAt = new Date();

    // One line whatever DEBUG_LEVEL is, but only when there was something to say: a healthy fleet
    // runs this hourly and finds nothing, and an hourly "released 0" teaches people to skip it.
    if (result.released || result.failed) {
      // eslint-disable-next-line no-console
      console.warn("[cron] stale credit reservations", {
        jobKey,
        dryRun,
        scanned: result.scanned,
        released: result.released,
        creditsReturned: result.creditsReturned,
        raced: result.raced,
        failed: result.failed,
      });
    }

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
