/**
 * Cron route: `GET|POST /api/cron/analytics-reconcile`
 *
 * Keeps `ShareLink`'s denormalized counters in step with the analytics rows, and reports the one
 * invariant a job cannot repair.
 *
 * Why it exists: every counter drift found so far was found by a person noticing two numbers on one
 * screen that could not both be true. That detector is slow and depends on somebody looking. The
 * arithmetic is cheap, so a job checks it nightly instead — `reconcileShareLinkCounters` repairs
 * what is repairable, and a page-time overrun (per-page time summing past a row's total, the
 * signature of a double count) is surfaced in `CronHealth.lastResult` because it is a code bug and
 * must not be silently "fixed" by overwriting data.
 *
 * `?dryRun=1` reports without writing. Vercel Cron invokes this with `GET` +
 * `Authorization: Bearer $CRON_SECRET`; `POST` is kept for manual invocation.
 */
import { NextResponse } from "next/server";

import { connectMongo } from "@/lib/mongodb";
import { CronHealthModel } from "@/lib/models/CronHealth";
import { ShareViewModel } from "@/lib/models/ShareView";
import { ShareVisitModel } from "@/lib/models/ShareVisit";
import { reconcileShareLinkCounters } from "@/lib/analytics/reconcileLinkCounters";
import { logErrorEvent, ERROR_CODE_CRON_JOB_FAILED } from "@/lib/errors/logger";
import { requireCronAuth } from "@/lib/cron/auth";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * A visit is only comparable once it is finished. A page turn reports its segment immediately while
 * the visit clock flushes on a 30-second heartbeat, so mid-read the pages legitimately lead the
 * total and catch up when the final flush lands.
 */
const SETTLE_MS = 3 * 60 * 1000;

/** Tolerance on the comparison: both numbers are best-effort deltas reported by a browser. */
const TIME_TOLERANCE_MS = 2000;

function sumMap(raw: unknown): number {
  if (!raw || typeof raw !== "object") return 0;
  let total = 0;
  for (const v of Object.values(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) total += v;
  }
  return total;
}

/** Settled rows whose per-page times do not fit inside their total. Reported, never repaired. */
async function findPageTimeOverruns(limit = 25): Promise<Array<{ collection: string; id: string; shareId: string; pagesMs: number; totalMs: number }>> {
  const settledBefore = new Date(Date.now() - SETTLE_MS);
  const settled = {
    $or: [
      { lastEventAt: { $lt: settledBefore } },
      { lastViewedAt: { $lt: settledBefore } },
      { lastEventAt: null, lastViewedAt: null },
    ],
  };
  const out: Array<{ collection: string; id: string; shareId: string; pagesMs: number; totalMs: number }> = [];
  for (const [name, model] of [
    ["shareviews", ShareViewModel],
    ["sharevisits", ShareVisitModel],
  ] as Array<[string, typeof ShareViewModel]>) {
    const rows = (await model
      .find(settled)
      .select({ _id: 1, shareId: 1, timeSpentMs: 1, pageTimeMsByPage: 1 })
      .lean()) as unknown as Array<{ _id: unknown; shareId?: string; timeSpentMs?: number; pageTimeMsByPage?: unknown }>;
    for (const row of rows) {
      const totalMs = typeof row.timeSpentMs === "number" && Number.isFinite(row.timeSpentMs) ? row.timeSpentMs : 0;
      const pagesMs = sumMap(row.pageTimeMsByPage);
      if (pagesMs > totalMs + TIME_TOLERANCE_MS) {
        if (out.length < limit) out.push({ collection: name, id: String(row._id), shareId: row.shareId ?? "", pagesMs, totalMs });
      }
    }
  }
  return out;
}

async function handle(request: Request) {
  const unauthorized = requireCronAuth(request);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dryRun") === "1";
  const jobKey = "analytics-reconcile";
  const startedAt = new Date();

  try {
    await connectMongo();
    await CronHealthModel.updateOne(
      { jobKey },
      { $set: { status: "running", lastStartedAt: startedAt, lastRunAt: startedAt, lastParams: { dryRun }, lastError: null } },
      { upsert: true },
    );
  } catch {
    // ignore
  }

  try {
    const counters = await reconcileShareLinkCounters({ dryRun });
    const pageTimeOverruns = await findPageTimeOverruns();
    const result = {
      ...counters,
      // Not repairable here on purpose: per-page time summing past a row's total means the ingest
      // counted something twice, and overwriting the rows would hide the bug rather than fix it.
      pageTimeOverruns: pageTimeOverruns.length,
      pageTimeOverrunSample: pageTimeOverruns,
    };

    const finishedAt = new Date();
    try {
      await CronHealthModel.updateOne(
        { jobKey },
        {
          $set: {
            status: pageTimeOverruns.length ? "error" : "ok",
            lastFinishedAt: finishedAt,
            lastRunAt: finishedAt,
            lastDurationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
            lastResult: result,
            ...(pageTimeOverruns.length
              ? { lastErrorAt: finishedAt, lastError: `${pageTimeOverruns.length} row(s) report more page time than total time` }
              : {}),
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
    const message = err instanceof Error ? err.message : String(err);
    void logErrorEvent({
      severity: "error",
      category: "cron",
      code: ERROR_CODE_CRON_JOB_FAILED,
      err,
      request,
      statusCode: 500,
      meta: { jobKey },
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
            lastDurationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
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
