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

/**
 * How far back this check looks.
 *
 * It used to look at everything, forever, and that is what made it dangerous rather than slow: a
 * nightly job that loads every settled row of two of the largest collections into a Node array
 * fails the moment the collection outgrows the function's heap, and it takes the counter
 * reconciliation in the same run down with it.
 *
 * A week is enough because of what this detects. An overrun means the ingest double-counted when
 * the row was written; it does not appear later. Every row older than this window was checked on
 * the night it was written and on the six nights after, so looking again buys nothing and the cost
 * of looking grows without limit.
 */
const OVERRUN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Settled rows whose per-page times do not fit inside their total. Reported, never repaired.
 *
 * The comparison happens in the database, and that is the whole change. It used to be
 * `model.find(settled).lean()` with no bound, materialising every settled row of `shareviews` and
 * `sharevisits` in Node and filtering them in a loop; `limit` capped the sample that came back, not
 * the scan. A nightly job that holds two of the busiest collections in memory does not get slower
 * as they grow, it stops working, and it takes the counter reconciliation in the same run with it.
 *
 * Now the server does the summing and the filtering and returns at most `limit` rows, so the memory
 * this costs is fixed no matter how large the collections get. Bounded in time as well by
 * `OVERRUN_WINDOW_MS`, and matched on each collection's own activity field rather than an `$or`
 * over both, so the window can use the indexes that already exist
 * (`shareviews.orgId_1_lastViewedAt_-1`, `sharevisits.orgId_1_lastEventAt_-1` and their siblings).
 */
async function findPageTimeOverruns(limit = 25): Promise<Array<{ collection: string; id: string; shareId: string; pagesMs: number; totalMs: number }>> {
  const now = Date.now();
  const settledBefore = new Date(now - SETTLE_MS);
  const windowStart = new Date(now - OVERRUN_WINDOW_MS);

  const out: Array<{ collection: string; id: string; shareId: string; pagesMs: number; totalMs: number }> = [];
  for (const [name, model, activityField] of [
    ["shareviews", ShareViewModel, "lastViewedAt"],
    ["sharevisits", ShareVisitModel, "lastEventAt"],
  ] as Array<[string, typeof ShareViewModel, string]>) {
    if (out.length >= limit) break;
    const rows = (await model.aggregate([
      { $match: { [activityField]: { $gte: windowStart, $lt: settledBefore } } },
      {
        $project: {
          shareId: 1,
          totalMs: { $ifNull: ["$timeSpentMs", 0] },
          // `pageTimeMsByPage` is a map of page number to milliseconds, so summing it means turning
          // the object into pairs first. Negative and non-numeric values are floored at zero, the
          // same way the old in-process sum did, because both numbers are deltas a browser reported.
          pagesMs: {
            $sum: {
              $map: {
                input: { $objectToArray: { $ifNull: ["$pageTimeMsByPage", {}] } },
                as: "kv",
                in: { $cond: [{ $gt: [{ $ifNull: ["$$kv.v", 0] }, 0] }, "$$kv.v", 0] },
              },
            },
          },
        },
      },
      { $match: { $expr: { $gt: ["$pagesMs", { $add: ["$totalMs", TIME_TOLERANCE_MS] }] } } },
      { $limit: limit - out.length },
    ])) as Array<{ _id: unknown; shareId?: string; totalMs?: number; pagesMs?: number }>;

    for (const row of rows) {
      out.push({
        collection: name,
        id: String(row._id),
        shareId: row.shareId ?? "",
        pagesMs: Number(row.pagesMs ?? 0),
        totalMs: Number(row.totalMs ?? 0),
      });
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
