/**
 * Cron route: `POST /api/cron/doc-metrics`
 *
 * Rolls up per-doc metrics into `Doc.metricsSnapshot` and writes a health heartbeat
 * to `CronHealth` so admins can see the last run status/duration.
 */
import { NextResponse } from "next/server";
import { rollupDocMetrics } from "@/lib/metrics/rollupDocMetrics";
import { connectMongo } from "@/lib/mongodb";
import { CronHealthModel } from "@/lib/models/CronHealth";
import { logErrorEvent, ERROR_CODE_CRON_JOB_FAILED } from "@/lib/errors/logger";

export const runtime = "nodejs";
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
 * Handle POST requests.
 */


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


