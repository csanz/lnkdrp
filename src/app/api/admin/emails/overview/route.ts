/**
 * Admin API route: `GET /api/admin/emails/overview`
 *
 * The catalog of every email the product can send, joined with what trace a send leaves behind,
 * plus the latest `CronHealth` snapshot for the two jobs that send mail and the schedule each runs
 * on. There is no send log to return: outside download requests, nothing per-message is stored.
 *
 * It also returns the notification queue's depth and its dead letters
 * (docs/prds/lnkdrp-notification-queue.md, M4). Those are the one place the page can say what is
 * *owed* rather than what the last tick happened to do.
 */
import { NextResponse } from "next/server";

import { connectMongo } from "@/lib/mongodb";
import { CronHealthModel } from "@/lib/models/CronHealth";
import { requireAdmin } from "@/lib/gating/requireAdmin";
import { EMAIL_CATALOG } from "@/lib/email/templates";
import {
  EMAIL_CRON_SCHEDULES,
  buildEmailCatalogRows,
  describeCronSchedule,
  summarizeNotificationRun,
  summarizePlanLimitsRun,
} from "@/lib/admin/emailsAdmin";
import { readDeadNotifications, readNotificationQueueSummary } from "@/lib/admin/notificationQueueAdmin";

export const runtime = "nodejs";

const NOTIFICATION_JOB = "notification-emails";
const PLAN_LIMITS_JOB = "plan-limits";

/** The snapshot fields the page renders; `lastResult` is summarized here, not shipped raw. */
type SnapshotRow = {
  jobKey: string;
  status: string | null;
  lastRunAt: string | null;
  lastFinishedAt: string | null;
  lastDurationMs: number | null;
  lastErrorAt: string | null;
  lastError: string | null;
  schedule: string;
  scheduleHuman: string;
};

/** A non-empty trimmed string, or null. */
function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Mongo hands back `Date`; the wire carries ISO strings. */
function asIso(v: unknown): string | null {
  return v instanceof Date ? v.toISOString() : null;
}

/** A finite number, or null. */
function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Shape one CronHealth document (or its absence) into the row the page renders. */
function toSnapshotRow(jobKey: string, doc: Record<string, unknown> | undefined): SnapshotRow {
  const schedule = EMAIL_CRON_SCHEDULES[jobKey] ?? "";
  return {
    jobKey,
    status: doc ? asString(doc.status) : null,
    lastRunAt: doc ? asIso(doc.lastRunAt) : null,
    lastFinishedAt: doc ? asIso(doc.lastFinishedAt) : null,
    lastDurationMs: doc ? asNumber(doc.lastDurationMs) : null,
    lastErrorAt: doc ? asIso(doc.lastErrorAt) : null,
    lastError: doc ? asString(doc.lastError) : null,
    schedule,
    scheduleHuman: schedule ? describeCronSchedule(schedule) : "",
  };
}

/** Handle GET requests. */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  await connectMongo();
  // Two documents at most: `jobKey` is unique, and the page only shows the jobs that send mail.
  const snapshots = await CronHealthModel.find({ jobKey: { $in: [NOTIFICATION_JOB, PLAN_LIMITS_JOB] } })
    .select({
      jobKey: 1,
      status: 1,
      lastRunAt: 1,
      lastFinishedAt: 1,
      lastDurationMs: 1,
      lastResult: 1,
      lastErrorAt: 1,
      lastError: 1,
    })
    .limit(2)
    .lean();

  const byKey = new Map<string, Record<string, unknown>>();
  for (const doc of snapshots) {
    const key = asString((doc as Record<string, unknown>).jobKey);
    if (key) byKey.set(key, doc as Record<string, unknown>);
  }

  const notificationDoc = byKey.get(NOTIFICATION_JOB);
  const planLimitsDoc = byKey.get(PLAN_LIMITS_JOB);

  // The depth and the dead letters are independent reads; neither throws, so a queue that cannot
  // be read costs the page its queue section and nothing else.
  const [queueSummary, deadLetters] = await Promise.all([readNotificationQueueSummary(), readDeadNotifications()]);

  return NextResponse.json({
    ok: true,
    catalog: buildEmailCatalogRows(EMAIL_CATALOG),
    notification: {
      snapshot: toSnapshotRow(NOTIFICATION_JOB, notificationDoc),
      // null when the job has never written a usable result — the page says so rather than
      // rendering a table of zeros that looks like "nothing was sent".
      run: summarizeNotificationRun(notificationDoc?.lastResult ?? null),
      // What is owed right now, as opposed to what the last tick did. Null when the collection
      // could not be read — the page says so rather than showing an empty queue.
      queue: queueSummary,
      dead: deadLetters,
    },
    planLimits: {
      snapshot: toSnapshotRow(PLAN_LIMITS_JOB, planLimitsDoc),
      run: summarizePlanLimitsRun(planLimitsDoc?.lastResult ?? null),
    },
  });
}
