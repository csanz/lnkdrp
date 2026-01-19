/**
 * Cron route: `POST /api/cron/usage-agg-reconcile`
 *
 * Recomputes usage aggregates from source-of-truth `CreditLedger` events for a date range.
 * Idempotent: overwrites deterministic totals via upserts (safe to re-run).
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { CronHealthModel } from "@/lib/models/CronHealth";
import { reconcileUsageAggsFromLedger } from "@/lib/usage/reconcile";
import { logErrorEvent, ERROR_CODE_CRON_JOB_FAILED } from "@/lib/errors/logger";

export const runtime = "nodejs";

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


