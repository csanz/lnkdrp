/**
 * `src/lib/admin/emailsAdmin.ts` is the shaping behind `/a/emails`, and the page's whole point is
 * that it only claims what the product actually records. Two things can quietly make it lie:
 *
 * - a new row in `EMAIL_CATALOG` that nobody classified, which would render as "not recorded" when
 *   it might be recorded, or vice versa;
 * - a cron schedule changed in `vercel.json` while the constant the page prints stays put.
 *
 * Both are covered here. The rest is narrowing `CronHealth.lastResult` (a `Mixed` field, so
 * anything can be in it) without throwing or inventing zeros.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { EMAIL_CATALOG } from "@/lib/email/templates";
import {
  EMAIL_CRON_SCHEDULES,
  buildEmailCatalogRows,
  describeCronSchedule,
  queueDepthFigures,
  sendOutcome,
  sendStateLabel,
  summarizeNotificationQueue,
  summarizeNotificationRun,
  summarizePlanLimitsRun,
  toDeadNotificationRows,
  traceLabel,
} from "@/lib/admin/emailsAdmin";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The cron entries as deployed, read from the real vercel.json. */
function vercelCrons(): { path: string; schedule: string }[] {
  const raw = readFileSync(path.join(repoRoot, "vercel.json"), "utf8");
  const parsed: unknown = JSON.parse(raw);
  const crons = (parsed as { crons?: unknown }).crons;
  return Array.isArray(crons) ? (crons as { path: string; schedule: string }[]) : [];
}

describe("email catalog rows", () => {
  test("every catalog row is classified", () => {
    const rows = buildEmailCatalogRows(EMAIL_CATALOG);
    expect(rows.length).toBe(EMAIL_CATALOG.length);
    for (const row of rows) {
      expect(row.traceNote, row.id).not.toMatch(/Not classified here/);
      expect(row.traceNote.length, row.id).toBeGreaterThan(0);
      // a row we cannot preview must say why; a row we can must not pretend there is a reason
      if (row.previewable) expect(row.previewNote, row.id).toBeNull();
      else expect(row.previewNote, row.id).toBeTruthy();
    }
  });

  test("only download-request emails are recorded per send", () => {
    const perSend = buildEmailCatalogRows(EMAIL_CATALOG)
      .filter((r) => r.trace === "per_send")
      .map((r) => r.id);
    expect(perSend).toEqual([
      "download_request.received",
      "download_request.owner",
      "download_request.approved",
    ]);
  });

  test("the repo-link-request rows carry their feature flag", () => {
    const rows = buildEmailCatalogRows(EMAIL_CATALOG);
    const repo = rows.filter((r) => r.id.startsWith("repo_link_request."));
    expect(repo.length).toBe(2);
    for (const r of repo) expect(r.flagGated).toBe("NEXT_PUBLIC_FEATURE_REQUESTS");
    // nothing else is flag-gated today
    expect(rows.filter((r) => r.flagGated !== null).length).toBe(2);
  });

  test("an id the page has never seen survives, marked unclassified", () => {
    const [row] = buildEmailCatalogRows([
      { id: "brand_new.email", what: "Something new", to: "owner", builtBy: "email/whatever.ts" },
    ]);
    expect(row.trace).toBe("none");
    expect(row.previewable).toBe(false);
    expect(row.traceNote).toMatch(/Not classified here/);
  });

  test("trace labels read as plain English", () => {
    expect(traceLabel("per_send")).toBe("Per send");
    expect(traceLabel("run_totals")).toBe("Run totals only");
    expect(traceLabel("none")).toBe("Not recorded");
  });
});

describe("cron schedules", () => {
  test("the mirrored schedules match vercel.json", () => {
    const crons = vercelCrons();
    for (const [jobKey, schedule] of Object.entries(EMAIL_CRON_SCHEDULES)) {
      const entry = crons.find((c) => c.path === `/api/cron/${jobKey}`);
      expect(entry, jobKey).toBeTruthy();
      expect(entry?.schedule, jobKey).toBe(schedule);
    }
  });

  test("describes the shapes we use", () => {
    expect(describeCronSchedule("*/5 * * * *")).toBe("every 5 minutes");
    expect(describeCronSchedule("40 * * * *")).toBe("hourly at :40");
    expect(describeCronSchedule("0 */6 * * *")).toBe("every 6 hours at :00");
    expect(describeCronSchedule("50 3 * * *")).toBe("daily at 03:50 UTC");
  });

  test("falls back to the raw expression rather than guessing", () => {
    expect(describeCronSchedule("0 0 * * 1")).toBe("0 0 * * 1");
    expect(describeCronSchedule("nonsense")).toBe("nonsense");
  });
});

/** A trimmed but shape-accurate `SendNotificationEmailsResult`. */
function notificationResult() {
  return {
    ok: true,
    now: "2026-09-17T23:05:00.000Z",
    dryRun: false,
    workspacesProcessed: 12,
    membersProcessed: 31,
    membersTruncated: false,
    sendFailures: 1,
    docUpdate: {
      immediate: { members: 2, emails: 2, events: 5, failed: 0 },
      daily: { members: 4, emails: 4, events: 9, failed: 1, sentTodayUtc: true },
    },
    repoLinkRequests: {
      immediate: { members: 0, emails: 0, events: 0, failed: 0 },
      daily: { members: 0, emails: 0, events: 0, failed: 0, sentTodayUtc: true },
    },
    views: {
      immediate: { members: 3, emails: 3, events: 7, failed: 0 },
      daily: { members: 6, emails: 6, events: 20, returns: 4, failed: 0, sentTodayUtc: true },
      off: { members: 5 },
      cursorsInitialized: 2,
      truncatedLoads: 0,
      errors: 0,
    },
  };
}

describe("notification run summary", () => {
  test("flattens every bucket, views first", () => {
    const summary = summarizeNotificationRun(notificationResult());
    expect(summary).not.toBeNull();
    expect(summary?.buckets.map((b) => b.key)).toEqual([
      "views.immediate",
      "views.daily",
      "docUpdate.immediate",
      "docUpdate.daily",
      "repoLinkRequests.immediate",
      "repoLinkRequests.daily",
    ]);
    const viewsDaily = summary?.buckets.find((b) => b.key === "views.daily");
    expect(viewsDaily?.emails).toBe(6);
    expect(viewsDaily?.returns).toBe(4);
    expect(viewsDaily?.sentTodayUtc).toBe(true);
    // only the views digest counts returns; the others have no such field
    expect(summary?.buckets.find((b) => b.key === "docUpdate.daily")?.returns).toBeNull();
  });

  test("carries the run-level fields and the cursor-only counters", () => {
    const summary = summarizeNotificationRun(notificationResult());
    expect(summary?.now).toBe("2026-09-17T23:05:00.000Z");
    expect(summary?.dryRun).toBe(false);
    expect(summary?.workspacesProcessed).toBe(12);
    expect(summary?.sendFailures).toBe(1);
    expect(summary?.viewsOffMembers).toBe(5);
    expect(summary?.viewsCursorsInitialized).toBe(2);
    expect(summary?.viewsErrors).toBe(0);
  });

  test("a missing bucket is dropped, not zero-filled", () => {
    const partial = { ok: true, views: { immediate: { members: 1, emails: 1, events: 1, failed: 0 } } };
    const summary = summarizeNotificationRun(partial);
    expect(summary?.buckets.map((b) => b.key)).toEqual(["views.immediate"]);
    expect(summary?.workspacesProcessed).toBeNull();
  });

  test("null when the snapshot has nothing usable", () => {
    expect(summarizeNotificationRun(null)).toBeNull();
    expect(summarizeNotificationRun("locked")).toBeNull();
    expect(summarizeNotificationRun({ ok: true, skipped: "locked" })).toBeNull();
  });
});

describe("plan-limits run summary", () => {
  test("narrows the sweep result", () => {
    const summary = summarizePlanLimitsRun({
      scanned: 40,
      started: 2,
      reminded: 3,
      blocked: 1,
      errors: 0,
      cleared: 1,
      upgraded: 0,
      dryRun: false,
    });
    expect(summary).toEqual({
      scanned: 40,
      started: 2,
      reminded: 3,
      blocked: 1,
      cleared: 1,
      upgraded: 0,
      errors: 0,
      dryRun: false,
    });
  });

  test("null for another job's payload", () => {
    expect(summarizePlanLimitsRun({ processed: 9, days: 30 })).toBeNull();
    expect(summarizePlanLimitsRun(undefined)).toBeNull();
  });
});

/**
 * The queue block (M4 of docs/prds/lnkdrp-notification-queue.md).
 *
 * The distinction these pin is the one the page exists to make: "the queue is empty" and "we could
 * not read the queue" must never render the same way. The cursor model's whole failure was that
 * nothing owed was written down anywhere, so a surface that quietly shows zeros for a queue it
 * could not reach would reproduce it on the admin side.
 */
describe("notification queue summary", () => {
  test("narrows the counts the route sends", () => {
    expect(
      summarizeNotificationQueue({
        pending: 12,
        due: 4,
        sending: 1,
        sent24h: 40,
        skipped: 3,
        dead: 2,
        oldestPendingAt: "2026-09-18T09:00:00.000Z",
      }),
    ).toEqual({
      pending: 12,
      due: 4,
      sending: 1,
      sent24h: 40,
      skipped: 3,
      dead: 2,
      oldestPendingAt: "2026-09-18T09:00:00.000Z",
    });
  });

  test("a status with no rows is zero, not a dash", () => {
    const summary = summarizeNotificationQueue({ pending: 5 });
    expect(summary?.dead).toBe(0);
    expect(summary?.sent24h).toBe(0);
    expect(summary?.oldestPendingAt).toBeNull();
  });

  test("null when there are no counts at all — not an empty queue", () => {
    expect(summarizeNotificationQueue(null)).toBeNull();
    expect(summarizeNotificationQueue(undefined)).toBeNull();
    expect(summarizeNotificationQueue("unavailable")).toBeNull();
    expect(summarizeNotificationQueue({ oldestPendingAt: "2026-09-18T09:00:00.000Z" })).toBeNull();
  });

  test("a count that is not a count reads as zero", () => {
    const summary = summarizeNotificationQueue({ pending: -3, due: Number.NaN, dead: "2", sent24h: 7.6 });
    expect(summary?.pending).toBe(0);
    expect(summary?.due).toBe(0);
    expect(summary?.dead).toBe(0);
    expect(summary?.sent24h).toBe(7);
  });
});

describe("dead letters", () => {
  test("carries the four fields the list shows, and the times around them", () => {
    const rows = toDeadNotificationRows([
      {
        id: "651f1f77bcf86cd799439011",
        dedupeKey: "share_views:64a:651",
        kind: "share_views",
        attempts: 5,
        lastError: "Resend 422: invalid recipient",
        occurredAt: "2026-09-18T09:00:00.000Z",
        failedAt: "2026-09-19T09:00:00.000Z",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dedupeKey: "share_views:64a:651",
      kind: "share_views",
      attempts: 5,
      lastError: "Resend 422: invalid recipient",
    });
  });

  test("a row without an id or a dedupe key is not a queue row", () => {
    expect(toDeadNotificationRows([{ dedupeKey: "share_views:64a:651" }, { id: "651" }, null, "x"])).toEqual([]);
    expect(toDeadNotificationRows({ id: "651" })).toEqual([]);
  });

  test("a kind written by a newer deploy still renders", () => {
    const [row] = toDeadNotificationRows([{ id: "651", dedupeKey: "k:1:2" }]);
    expect(row.kind).toBe("unknown");
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBeNull();
  });
});

describe("queue depth on the cron board", () => {
  const summary = {
    pending: 0,
    due: 0,
    sending: 0,
    sent24h: 5,
    skipped: 0,
    dead: 2,
    oldestPendingAt: null,
  };

  test("what is not zero comes first, so the first figures are the interesting ones", () => {
    expect(queueDepthFigures(summary).map((f) => f.label)).toEqual(["dead", "sent 24h", "pending", "due"]);
  });

  test("dead is the only toned figure, and only while there are any", () => {
    expect(queueDepthFigures(summary).find((f) => f.label === "dead")?.tone).toBe("danger");
    expect(queueDepthFigures({ ...summary, dead: 0 }).find((f) => f.label === "dead")?.tone).toBeUndefined();
    expect(queueDepthFigures(summary).filter((f) => f.tone).length).toBe(1);
  });

  test("no figures at all when the queue could not be read", () => {
    expect(queueDepthFigures(null)).toEqual([]);
  });
});

describe("download-request send outcomes", () => {
  test("a timestamp means sent", () => {
    expect(sendOutcome("2026-09-17T10:00:00.000Z", null)).toEqual({
      state: "sent",
      at: "2026-09-17T10:00:00.000Z",
      error: null,
    });
  });

  test("an error with no timestamp means failed", () => {
    expect(sendOutcome(null, "Resend 422")).toEqual({ state: "failed", at: null, error: "Resend 422" });
  });

  test("both empty means not attempted, which is not the same as not sent", () => {
    expect(sendOutcome(null, null).state).toBe("not_attempted");
    expect(sendOutcome(undefined, "   ").state).toBe("not_attempted");
    expect(sendStateLabel("not_attempted")).toBe("Not attempted");
  });
});
