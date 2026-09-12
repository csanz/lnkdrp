/**
 * Cron route: `GET|POST /api/cron/doc-metrics`
 *
 * Rolls up per-doc metrics into `Doc.metricsSnapshot` and writes a health heartbeat
 * to `CronHealth` so admins can see the last run status/duration.
 *
 * Vercel Cron invokes this with `GET` + `Authorization: Bearer $CRON_SECRET`;
 * `POST` is kept for manual/dev invocation. Auth: `requireCronAuth`.
 */
import { NextResponse } from "next/server";
import { rollupDocMetrics } from "@/lib/metrics/rollupDocMetrics";
import { connectMongo } from "@/lib/mongodb";
import { CronHealthModel } from "@/lib/models/CronHealth";
import { logErrorEvent, ERROR_CODE_CRON_JOB_FAILED } from "@/lib/errors/logger";
import { requireCronAuth } from "@/lib/cron/auth";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * As Positive Int (uses Number, isFinite, floor).
 */
function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
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
  const docId = url.searchParams.get("docId") ?? undefined;
  const limit = asPositiveInt(url.searchParams.get("limit"));
  const days = asPositiveInt(url.searchParams.get("days"));

  const startedAt = new Date();
  const params = {
    ...(docId ? { docId } : {}),
    ...(limit ? { limit } : {}),
    ...(days ? { days } : {}),
  };

  // Health snapshot: best-effort (should not block rollup itself).
  try {
    await connectMongo();
    await CronHealthModel.updateOne(
      { jobKey: "doc-metrics" },
      {
        $set: {
          status: "running",
          lastStartedAt: startedAt,
          lastRunAt: startedAt,
          lastParams: params,
          lastError: null,
        },
      },
      { upsert: true },
    );
  } catch {
    // ignore
  }

  try {
    const res = await rollupDocMetrics(params);
    const finishedAt = new Date();
    const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());

    try {
      await connectMongo();
      await CronHealthModel.updateOne(
        { jobKey: "doc-metrics" },
        {
          $set: {
            status: "ok",
            lastFinishedAt: finishedAt,
            lastRunAt: finishedAt,
            lastDurationMs: durationMs,
            lastResult: {
              ok: res.ok,
              processed: res.processed,
              days: res.days,
              viewsLastDaysTotal: res.viewsLastDaysTotal,
              downloadsLastDaysTotal: res.downloadsLastDaysTotal,
              downloadsTotalTotal: res.downloadsTotalTotal,
            },
          },
        },
        { upsert: true },
      );
    } catch {
      // ignore
    }

    return NextResponse.json(res);
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
      meta: { jobKey: "doc-metrics", params, durationMs },
    });

    try {
      await connectMongo();
      await CronHealthModel.updateOne(
        { jobKey: "doc-metrics" },
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
