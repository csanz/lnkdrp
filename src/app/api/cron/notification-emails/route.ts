/**
 * Cron route: `POST /api/cron/notification-emails`
 *
 * Sends workspace notification emails based on saved preferences:
 * - doc update emails (replacement diffs)
 * - repo link request emails (new completed uploads into request repos)
 *
 * The route is intended to be invoked by Vercel Cron (see `vercel.json` + `docs/CRON.md`).
 */
import { NextResponse } from "next/server";
import { connectMongo } from "@/lib/mongodb";
import { CronHealthModel } from "@/lib/models/CronHealth";
import { logErrorEvent, ERROR_CODE_CRON_JOB_FAILED } from "@/lib/errors/logger";
import { sendNotificationEmails } from "@/lib/notifications/sendNotificationEmails";

export const runtime = "nodejs";

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

  const jobKey = "notification-emails";
  const startedAt = new Date();

  const dryRun = url.searchParams.get("dryRun") === "1";
  const forceDigest = url.searchParams.get("forceDigest") === "1";
  const workspaceId = (url.searchParams.get("workspaceId") ?? "").trim() || null;
  const userId = (url.searchParams.get("userId") ?? "").trim() || null;
  const limitMembers = asPositiveInt(url.searchParams.get("limitMembers"));
  const limitEventsPerMember = asPositiveInt(url.searchParams.get("limitEventsPerMember"));
  const limitEventsPerOrg = asPositiveInt(url.searchParams.get("limitEventsPerOrg"));
  const defaultLookbackDays = asPositiveInt(url.searchParams.get("defaultLookbackDays"));

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
            dryRun,
            forceDigest,
            workspaceId,
            userId,
            limitMembers,
            limitEventsPerMember,
            limitEventsPerOrg,
            defaultLookbackDays,
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
    const result = await sendNotificationEmails({
      dryRun,
      forceDigest,
      workspaceId,
      userId,
      ...(limitMembers ? { limitMembers } : {}),
      ...(limitEventsPerMember ? { limitEventsPerMember } : {}),
      ...(limitEventsPerOrg ? { limitEventsPerOrg } : {}),
      ...(defaultLookbackDays ? { defaultLookbackDays } : {}),
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

