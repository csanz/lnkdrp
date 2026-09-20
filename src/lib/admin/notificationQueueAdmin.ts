/**
 * Reads the notification queue for the two admin surfaces that show it: the Emails page
 * (`/a/emails`) and the cron board's `notification-emails` row (`/a/cron-health`).
 *
 * Unlike its neighbours in this folder this module touches Mongo, because both surfaces ask the
 * same question and the two answers have to be identical — the shaping of the result is still
 * pure, and lives in `emailsAdmin.ts` with the rest of the page's vocabulary.
 *
 * Nothing here writes. A dead row stays dead until someone deals with it (see the PRD's open
 * question 1, which proposes an admin retry); this file only reports.
 */
import { connectMongo } from "@/lib/mongodb";
import { NotificationQueueModel } from "@/lib/models/NotificationQueue";
import { queueDepth } from "@/lib/notifications/queue";
import { debugError } from "@/lib/debug";
import type { DeadNotificationRow, NotificationQueueSummary } from "@/lib/admin/emailsAdmin";

/** The window `sent24h` counts over. A window, not a total: `sent` rows expire after 30 days. */
const SENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How many dead letters the page lists. Enough to see a pattern, bounded so the row stays a row. */
export const DEAD_LETTER_LIMIT = 50;

/** Mongo hands back `Date`; the wire carries ISO strings. */
function asIso(v: unknown): string | null {
  return v instanceof Date ? v.toISOString() : null;
}

/** A non-empty trimmed string, or null. */
function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * The queue's depth right now, or null when the collection could not be read.
 *
 * Null rather than a throw: the cron board exists to show every job's state, and a queue that is
 * unreachable must not take the other nine rows down with it. The surfaces render "no counts",
 * which is the truth, instead of zeros, which would read as an empty queue.
 */
export async function readNotificationQueueSummary(now: Date = new Date()): Promise<NotificationQueueSummary | null> {
  try {
    await connectMongo();
    // The depth summary has no notion of a window, so the 24h figure is its own count. Everything
    // here is a count or a one-row read on an indexed field, run on every load of two pages — the
    // collection holds 30 days of `sent` rows fanned out one per member per event, so anything
    // that touches every document is a page that gets slower the more mail the product sends.
    const [depth, sent24h] = await Promise.all([
      queueDepth({ now }),
      NotificationQueueModel.countDocuments({
        status: "sent",
        sentAt: { $gte: new Date(now.getTime() - SENT_WINDOW_MS) },
      }),
    ]);
    return {
      pending: depth.pending,
      due: depth.due,
      sending: depth.sending,
      sent24h: Number.isFinite(sent24h) ? sent24h : 0,
      skipped: depth.skipped,
      dead: depth.dead,
      oldestPendingAt: depth.oldestPendingAt ? depth.oldestPendingAt.toISOString() : null,
    };
  } catch (err) {
    debugError(1, "[admin] notification queue depth failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * The dead letters, newest failure first.
 *
 * Only the queue's own fields are selected. The `event` subdocument carries the document, the
 * share link and the reader's name and address, and an admin answering "why is mail failing?"
 * needs the error, not the mail (`src/lib/admin/docPrivacy.ts`).
 */
export async function readDeadNotifications(limit: number = DEAD_LETTER_LIMIT): Promise<DeadNotificationRow[]> {
  const cap = Math.min(Math.max(Math.floor(Number(limit) || 0), 1), DEAD_LETTER_LIMIT);
  try {
    await connectMongo();
    const rows = await NotificationQueueModel.find({ status: "dead" })
      // Sorted on `nextAttemptAt` rather than on `updatedDate` so the `{status, nextAttemptAt}`
      // index orders the rows for free. It is the right field either way: `markFailed` stamps a
      // dead row's `nextAttemptAt` with the instant it gave up, and nothing writes the row again.
      .sort({ nextAttemptAt: -1 })
      .limit(cap)
      .select({ dedupeKey: 1, kind: 1, attempts: 1, lastError: 1, occurredAt: 1, nextAttemptAt: 1 })
      .lean();

    return rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: String(r._id),
        dedupeKey: asString(r.dedupeKey) ?? "",
        kind: asString(r.kind) ?? "unknown",
        attempts: typeof r.attempts === "number" && Number.isFinite(r.attempts) ? r.attempts : 0,
        lastError: asString(r.lastError),
        occurredAt: asIso(r.occurredAt),
        failedAt: asIso(r.nextAttemptAt),
      };
    });
  } catch (err) {
    debugError(1, "[admin] dead notification list failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
