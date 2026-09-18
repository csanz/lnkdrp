/**
 * Cron route: `GET|POST /api/cron/account-purge`
 *
 * Removes accounts whose 30-day grace period has run out: stored files first, then the rows
 * (`src/lib/accounts/purge.ts`). Daily. Idempotent — an account already purged no longer matches
 * the query, so a doubled run is a no-op.
 *
 * `?dryRun=1` reports exactly what it would remove and writes nothing, which is how this job is
 * meant to be tested; `?limit=N` caps the accounts handled in one run; `?userId=<id>` purges one
 * named account that is already due, for a support case.
 *
 * Vercel Cron invokes this with `GET` + `Authorization: Bearer $CRON_SECRET`; `POST` is for manual
 * runs. Auth: `requireCronAuth`.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { CronHealthModel } from "@/lib/models/CronHealth";
import { UserModel } from "@/lib/models/User";
import { logErrorEvent, ERROR_CODE_CRON_JOB_FAILED } from "@/lib/errors/logger";
import { requireCronAuth } from "@/lib/cron/auth";
import { findAccountsDueForPurge, purgeAccount } from "@/lib/accounts/purge";

export const runtime = "nodejs";
export const maxDuration = 300;

const jobKey = "account-purge";

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

  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dryRun") === "1";
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw >= 1 ? Math.floor(limitRaw) : 25;
  const onlyUserId = (url.searchParams.get("userId") ?? "").trim();

  const startedAt = new Date();
  // A dry run is a report, not a run: it must not overwrite the health row that says when the job
  // last really executed.
  if (!dryRun) {
    await recordHealth({ status: "running", lastStartedAt: startedAt, lastRunAt: startedAt, lastParams: { limit }, lastError: null });
  }

  try {
    await connectMongo();
    let due: string[];
    if (onlyUserId) {
      if (!Types.ObjectId.isValid(onlyUserId)) return NextResponse.json({ error: "Invalid userId" }, { status: 400 });
      const all = await findAccountsDueForPurge(startedAt, 1000);
      due = all.filter((id) => id === onlyUserId);
    } else {
      due = await findAccountsDueForPurge(startedAt, limit);
    }

    const results = [];
    for (const userId of due) {
      const res = await purgeAccount(userId, { dryRun });
      if (!res) continue;
      if (!dryRun) {
        // The user row is gone; this stamp is for the accounts that survive as tombstones (a
        // membership in a workspace that is still alive keeps no user row, so this is a no-op then).
        await UserModel.updateOne({ _id: new Types.ObjectId(userId) }, { $set: { deletionPurgedAt: new Date() } }).catch(() => undefined);
      }
      results.push(res);
    }

    const summary = {
      dryRun,
      due: due.length,
      purged: dryRun ? 0 : results.length,
      docs: results.reduce((n, r) => n + r.counts.docs, 0),
      uploads: results.reduce((n, r) => n + r.counts.uploads, 0),
      blobs: results.reduce((n, r) => n + r.counts.blobs, 0),
      blobsDeleted: results.reduce((n, r) => n + r.blobsDeleted, 0),
      blobErrors: results.reduce((n, r) => n + r.blobErrors, 0),
      workspaces: results.reduce((n, r) => n + r.soloOrgIds.length, 0),
      accounts: results.map((r) => ({
        userId: r.userId,
        email: r.email,
        requestedAt: r.requestedAt,
        soloWorkspaces: r.soloOrgIds.length,
        sharedWorkspaces: r.sharedOrgIds.length,
        counts: r.counts,
      })),
    };

    const finishedAt = new Date();
    if (!dryRun) {
      await recordHealth({
        status: "ok",
        lastFinishedAt: finishedAt,
        lastRunAt: finishedAt,
        lastDurationMs: finishedAt.getTime() - startedAt.getTime(),
        lastResult: summary,
      });
    }
    return NextResponse.json({ ok: true, ...summary });
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
    if (!dryRun) {
      await recordHealth({
        status: "error",
        lastFinishedAt: finishedAt,
        lastRunAt: finishedAt,
        lastDurationMs: finishedAt.getTime() - startedAt.getTime(),
        lastErrorAt: finishedAt,
        lastError: message,
      });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Vercel Cron entrypoint. */
export const GET = handle;
/** Manual/dev entrypoint. */
export const POST = handle;
