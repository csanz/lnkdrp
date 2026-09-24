/**
 * Cron route: `GET|POST /api/cron/notification-emails`
 *
 * Drains the notification queue (docs/prds/lnkdrp-notification-queue.md): view emails, doc update
 * emails and repo link request emails, each row one email owed to one member, sent according to
 * that member's preference at the moment it is claimed.
 *
 * The route is intended to be invoked by Vercel Cron (see `vercel.json` + `docs/CRON.md`).
 * Vercel sends `GET` + `Authorization: Bearer $CRON_SECRET`; `POST` is kept for manual runs.
 *
 * Overlap protection: acquires a `CronHealth` lease so a slow run cannot overlap the
 * next 5-minute tick (which could double-send emails). Returns `{ skipped: "locked" }`
 * with 200 when another run holds the lease.
 */
import { NextResponse } from "next/server";
import { connectMongo } from "@/lib/mongodb";
import { CronHealthModel } from "@/lib/models/CronHealth";
import { logErrorEvent, ERROR_CODE_CRON_JOB_FAILED } from "@/lib/errors/logger";
import { sendNotificationEmails } from "@/lib/notifications/sendNotificationEmails";
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

/**
 * Shared handler for GET (Vercel Cron) and POST (manual) invocations.
 */
async function handle(request: Request) {
  const unauthorized = requireCronAuth(request);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const jobKey = "notification-emails";
  const startedAt = new Date();

  const dryRun = url.searchParams.get("dryRun") === "1";
  const forceDigest = url.searchParams.get("forceDigest") === "1";
  const workspaceId = (url.searchParams.get("workspaceId") ?? "").trim() || null;
  const userId = (url.searchParams.get("userId") ?? "").trim() || null;
  const limitMembers = asPositiveInt(url.searchParams.get("limitMembers"));
  const limitEventsPerMember = asPositiveInt(url.searchParams.get("limitEventsPerMember"));

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
          lastParams: { dryRun, forceDigest, workspaceId, userId, limitMembers, limitEventsPerMember },
          lastError: null,
        },
      },
      { upsert: true },
    );
  } catch {
    // ignore
  }

  try {
    const result = await sendNotificationEmails({
      dryRun,
      forceDigest,
      workspaceId,
      userId,
      ...(limitMembers ? { limitMembers } : {}),
      ...(limitEventsPerMember ? { limitEventsPerMember } : {}),
    });

    const finishedAt = new Date();
    const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());

    /**
     * A tick that completed is not the same as a tick that worked.
     *
     * This recorded `status: "ok"` on every run that did not throw, so a tick that dead-lettered
     * mail or skipped members at the cap looked identical in health to a clean one — and health is
     * the only place anybody looks. The counts were in `lastResult` the whole time; nothing read
     * them.
     *
     * Only the two conditions a person must act on flip the status. `sendFailures` does not: those
     * rows stay on the backoff schedule and the next tick retries them, so raising an alarm every
     * time a provider blips would teach an operator to ignore the light. Dead-lettered rows will
     * never be retried, and truncation means members got nothing this tick with no record of who.
     */
    const dead = result.queue?.dead ?? 0;
    const truncated = Boolean(result.membersTruncated);
    const failures = result.sendFailures ?? 0;

    const problems: string[] = [];
    if (dead > 0) problems.push(`${dead} notification${dead === 1 ? "" : "s"} dead-lettered and will not be retried`);
    if (truncated) problems.push(`stopped at limitMembers: some members got nothing this tick`);

    try {
      await connectMongo();
      await CronHealthModel.updateOne(
        { jobKey },
        {
          $set: {
            status: problems.length ? "error" : "ok",
            lastFinishedAt: finishedAt,
            lastRunAt: finishedAt,
            lastDurationMs: durationMs,
            lastResult: result,
            ...(problems.length
              ? { lastErrorAt: finishedAt, lastError: problems.join("; ") }
              : {}),
            // Retryable failures are worth seeing without being worth an alarm.
            ...(failures > 0 && !problems.length ? { lastError: `${failures} send(s) failed and will retry` } : {}),
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
