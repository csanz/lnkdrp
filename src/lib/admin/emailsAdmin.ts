/**
 * Shaping for the admin Emails page (`/a/emails`).
 *
 * Two jobs, both pure:
 *
 * 1. Say, per catalog row, what trace a send leaves behind. Only download-request emails are
 *    recorded per send (`ShareDownloadRequest.*EmailSentAt/Error`). Everything else leaves either
 *    run-level counters in `CronHealth.lastResult` or nothing at all. The page has to say which,
 *    because a reader looking at "12 emails" on a cron snapshot will otherwise assume there is a
 *    list of those twelve somewhere. There is not.
 * 2. Flatten `CronHealth.lastResult` for `notification-emails` and `plan-limits` into rows a table
 *    can render, narrowing every field off `Mixed` instead of casting.
 * 3. Narrow the notification queue's depth and its dead letters (M4 of
 *    docs/prds/lnkdrp-notification-queue.md) for the two surfaces that show them.
 *
 * Deliberately dependency-free (no mongoose, no models, no template imports) so it is safe to
 * import from a client component and cheap to test.
 */
import type { CronStat } from "./cronHealth";

// ---------------------------------------------------------------------------------------------
// Catalog: what trace does each email leave?
// ---------------------------------------------------------------------------------------------

/**
 * How much evidence exists that one of these emails went out.
 *
 * - `per_send`  — a row per message, with a timestamp and the error when it failed.
 * - `run_totals` — only counters for a whole cron tick, overwritten by the next tick.
 * - `none`      — nothing is written anywhere; the only record is a Vercel log line.
 */
export type EmailTrace = "per_send" | "run_totals" | "none";

/** Who an email is addressed to. Mirrors the catalog's own union, structurally. */
export type EmailAudience = "owner" | "member" | "requester" | "invitee" | "reader";

/** One catalog row as the page renders it: the raw catalog entry plus what we know about it. */
export type EmailCatalogRow = {
  id: string;
  what: string;
  to: EmailAudience;
  builtBy: string;
  trace: EmailTrace;
  /** Where the trace lives, or why there is none. Rendered verbatim. */
  traceNote: string;
  /** True when a pure builder exists that the previews route can call with sample inputs. */
  previewable: boolean;
  /** Why it cannot be previewed; null when it can. */
  previewNote: string | null;
  /** Env flag that must be on for this email to send at all; null when it always sends. */
  flagGated: string | null;
};

/** The catalog shape we accept, structurally — avoids importing the email templates barrel. */
export type EmailCatalogEntry = {
  id: string;
  what: string;
  to: EmailAudience;
  builtBy: string;
};

type EmailFacts = Omit<EmailCatalogRow, keyof EmailCatalogEntry>;

const PER_SEND_NOTE =
  "ShareDownloadRequest stores a sent-at and an error per message — the only per-send record in the product.";
const VIEW_RUN_NOTE = "Not recorded per send. Only the notification-emails run counters below (views.*).";
const DOC_RUN_NOTE = "Not recorded per send. Only the notification-emails run counters below (docUpdate.*).";
const REPO_RUN_NOTE = "Not recorded per send. Only the notification-emails run counters below (repoLinkRequests.*).";
const INLINE_NOTE = "Body is built inline inside sendNotificationEmails(); there is no exported builder to call.";

/**
 * What we know about each catalog id, by hand, from reading the senders.
 *
 * Keyed rather than positional because `EMAIL_CATALOG` is hand-maintained and reorders; an id we
 * have not classified falls through to `UNCLASSIFIED` rather than borrowing its neighbour's facts.
 */
const EMAIL_FACTS: Readonly<Record<string, EmailFacts>> = {
  "download_request.received": {
    trace: "per_send",
    traceNote: PER_SEND_NOTE,
    previewable: true,
    previewNote: null,
    flagGated: null,
  },
  "download_request.owner": {
    trace: "per_send",
    traceNote: PER_SEND_NOTE,
    previewable: true,
    previewNote: null,
    flagGated: null,
  },
  "download_request.approved": {
    trace: "per_send",
    traceNote: PER_SEND_NOTE,
    previewable: true,
    previewNote: null,
    flagGated: null,
  },
  member_removed: {
    trace: "none",
    traceNote:
      "Not recorded: the revoke route sends it best-effort and never waits for it. The member.removed activity row records the removal, not the delivery.",
    previewable: true,
    previewNote: null,
    flagGated: null,
  },
  waitlist_approved: {
    trace: "none",
    traceNote:
      "Not recorded: the approve route sends it best-effort. User.approvedAt records that we let them in, not that the mail arrived.",
    previewable: true,
    previewNote: null,
    flagGated: null,
  },
  viewer_verify: {
    trace: "none",
    traceNote:
      "Not recorded: sent best-effort when a reader introduces themselves, and deliberately gates nothing — the document is already open either way. The introduction itself is what we store; the delivery is not.",
    previewable: true,
    previewNote: null,
    flagGated: null,
  },
  viewer_introduced: {
    trace: "none",
    traceNote:
      "Not recorded: sent best-effort, and only when the anonymous view email already went out. The share_views mail that it corrects is counted in that job's run totals, this one is not.",
    previewable: true,
    previewNote: null,
    flagGated: null,
  },
  org_invite: {
    trace: "none",
    traceNote:
      "Not recorded: OrgInvite has recipientEmail but no emailSentAt/emailError, so an invite row means we tried, nothing more.",
    previewable: false,
    previewNote:
      "Body is inline in sendOrgInviteEmail, which posts to Resend directly — calling it would send a real email.",
    flagGated: null,
  },
  plan_limit: {
    trace: "run_totals",
    traceNote:
      "Not recorded per owner. The plan-limits run counts errors (email failures and write failures together); Org.planGrace.remindersSent and the plan.grace_* activity rows record the transition, not the delivery.",
    previewable: true,
    previewNote: null,
    flagGated: null,
  },
  "share_views.immediate": {
    trace: "run_totals",
    traceNote: VIEW_RUN_NOTE,
    previewable: true,
    previewNote: null,
    flagGated: null,
  },
  "share_views.daily": {
    trace: "run_totals",
    traceNote: VIEW_RUN_NOTE,
    previewable: true,
    previewNote: null,
    flagGated: null,
  },
  "doc_update.immediate": {
    trace: "run_totals",
    traceNote: DOC_RUN_NOTE,
    previewable: false,
    previewNote: INLINE_NOTE,
    flagGated: null,
  },
  "doc_update.daily": {
    trace: "run_totals",
    traceNote: DOC_RUN_NOTE,
    previewable: false,
    previewNote: INLINE_NOTE,
    flagGated: null,
  },
  "repo_link_request.immediate": {
    trace: "run_totals",
    traceNote: REPO_RUN_NOTE,
    previewable: false,
    previewNote: INLINE_NOTE,
    flagGated: "NEXT_PUBLIC_FEATURE_REQUESTS",
  },
  "repo_link_request.daily": {
    trace: "run_totals",
    traceNote: REPO_RUN_NOTE,
    previewable: false,
    previewNote: INLINE_NOTE,
    flagGated: "NEXT_PUBLIC_FEATURE_REQUESTS",
  },
};

const UNCLASSIFIED: EmailFacts = {
  trace: "none",
  traceNote: "Not classified here — this id was added to EMAIL_CATALOG after the admin page was written.",
  previewable: false,
  previewNote: "No preview wired up for this id.",
  flagGated: null,
};

/** Join the catalog with what we know about each row. Unknown ids survive, marked unclassified. */
export function buildEmailCatalogRows(catalog: readonly EmailCatalogEntry[]): EmailCatalogRow[] {
  return catalog.map((row) => ({ ...row, ...(EMAIL_FACTS[row.id] ?? UNCLASSIFIED) }));
}

/** Short label for the trace column. */
export function traceLabel(trace: EmailTrace): string {
  if (trace === "per_send") return "Per send";
  if (trace === "run_totals") return "Run totals only";
  return "Not recorded";
}

// ---------------------------------------------------------------------------------------------
// Cron schedules
// ---------------------------------------------------------------------------------------------

/**
 * The two cron entries that send email, mirrored from `vercel.json`.
 *
 * Mirrored rather than read at runtime because `vercel.json` is not part of the serverless bundle.
 * `tests/lib/adminEmails.test.ts` reads the real file and fails when these drift.
 */
export const EMAIL_CRON_SCHEDULES: Readonly<Record<string, string>> = {
  "notification-emails": "*/5 * * * *",
  "plan-limits": "40 * * * *",
};

/**
 * Describe the handful of cron shapes we actually use, in words.
 *
 * Falls back to the raw expression rather than guessing, so a schedule change that this does not
 * understand shows the truth instead of a wrong sentence.
 */
export function describeCronSchedule(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts;
  if (dom !== "*" || mon !== "*" || dow !== "*") return expr;

  const everyMin = /^\*\/(\d+)$/.exec(min);
  if (everyMin && hour === "*") return `every ${everyMin[1]} minutes`;

  const minAt = /^(\d{1,2})$/.exec(min);
  if (!minAt) return expr;
  const mm = String(Number(minAt[1])).padStart(2, "0");

  if (hour === "*") return `hourly at :${mm}`;

  const everyHour = /^\*\/(\d+)$/.exec(hour);
  if (everyHour) return `every ${everyHour[1]} hours at :${mm}`;

  const hourAt = /^(\d{1,2})$/.exec(hour);
  if (hourAt) return `daily at ${String(Number(hourAt[1])).padStart(2, "0")}:${mm} UTC`;

  return expr;
}

// ---------------------------------------------------------------------------------------------
// CronHealth.lastResult → rows
// ---------------------------------------------------------------------------------------------

/** True for an object we can safely index — `lastResult` is `Mixed`, so it can be anything. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** A finite number, or null: a missing counter renders as an em dash, never as 0. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A real boolean, or null when the field was absent. */
function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/** A non-empty trimmed string, or null. */
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** One bucket of the notification job's result, as the table renders it. */
export type NotificationBucketRow = {
  /** `views.immediate`, `docUpdate.daily`, … — matches the key path in `lastResult`. */
  key: string;
  label: string;
  /** Distinct recipients emailed. */
  members: number | null;
  /** Messages sent. */
  emails: number | null;
  /** Source rows covered (viewers / doc changes / uploads). */
  events: number | null;
  /** Sends that threw in this bucket. */
  failed: number | null;
  /** Returning-reader events folded into the digest; only the views digest has these. */
  returns: number | null;
  /** Whether the daily gate was open this tick — NOT whether a digest went out. */
  sentTodayUtc: boolean | null;
};

export type NotificationRunSummary = {
  /** ISO `now` the run used. */
  now: string | null;
  dryRun: boolean | null;
  workspacesProcessed: number | null;
  membersProcessed: number | null;
  membersTruncated: boolean | null;
  /** Total recipient sends that threw, across every bucket. */
  sendFailures: number | null;
  buckets: NotificationBucketRow[];
  /** Cursor moves with nothing sent: members with views off, plus first-run cursor seeding. */
  viewsOffMembers: number | null;
  viewsCursorsInitialized: number | null;
  /** Workspaces whose view block threw outright. */
  viewsErrors: number | null;
};

const BUCKET_LABELS: readonly { path: [string, string]; label: string }[] = [
  { path: ["views", "immediate"], label: "Share views — immediate" },
  { path: ["views", "daily"], label: "Share views — daily digest" },
  { path: ["docUpdate", "immediate"], label: "Doc updates — immediate" },
  { path: ["docUpdate", "daily"], label: "Doc updates — daily digest" },
  { path: ["repoLinkRequests", "immediate"], label: "Repo link requests — immediate" },
  { path: ["repoLinkRequests", "daily"], label: "Repo link requests — daily digest" },
];

/**
 * Flatten `CronHealth.lastResult` for `notification-emails` into per-type rows.
 *
 * Returns null when the snapshot has no usable result (job never ran, or it crashed before
 * writing one) so the page can say that instead of rendering a table of zeros.
 */
export function summarizeNotificationRun(lastResult: unknown): NotificationRunSummary | null {
  if (!isPlainObject(lastResult)) return null;

  const buckets: NotificationBucketRow[] = [];
  for (const { path, label } of BUCKET_LABELS) {
    const group = lastResult[path[0]];
    if (!isPlainObject(group)) continue;
    const bucket = group[path[1]];
    if (!isPlainObject(bucket)) continue;
    buckets.push({
      key: `${path[0]}.${path[1]}`,
      label,
      members: num(bucket.members),
      emails: num(bucket.emails),
      events: num(bucket.events),
      failed: num(bucket.failed),
      returns: num(bucket.returns),
      sentTodayUtc: bool(bucket.sentTodayUtc),
    });
  }
  if (buckets.length === 0) return null;

  const views = isPlainObject(lastResult.views) ? lastResult.views : null;
  const viewsOff = views && isPlainObject(views.off) ? views.off : null;

  return {
    now: str(lastResult.now),
    dryRun: bool(lastResult.dryRun),
    workspacesProcessed: num(lastResult.workspacesProcessed),
    membersProcessed: num(lastResult.membersProcessed),
    membersTruncated: bool(lastResult.membersTruncated),
    sendFailures: num(lastResult.sendFailures),
    buckets,
    viewsOffMembers: viewsOff ? num(viewsOff.members) : null,
    viewsCursorsInitialized: views ? num(views.cursorsInitialized) : null,
    viewsErrors: views ? num(views.errors) : null,
  };
}

/** The plan-limits sweep result (`PlanLimitsGraceSweepResult`), narrowed off `Mixed`. */
export type PlanLimitsRunSummary = {
  scanned: number | null;
  started: number | null;
  reminded: number | null;
  blocked: number | null;
  cleared: number | null;
  upgraded: number | null;
  /** Failed emails and failed writes together — the sweep does not separate them. */
  errors: number | null;
  dryRun: boolean | null;
};

/** Narrow `CronHealth.lastResult` for `plan-limits`; null when the job has no usable result yet. */
export function summarizePlanLimitsRun(lastResult: unknown): PlanLimitsRunSummary | null {
  if (!isPlainObject(lastResult)) return null;
  const scanned = num(lastResult.scanned);
  const started = num(lastResult.started);
  const blocked = num(lastResult.blocked);
  // `scanned` is written on every sweep; without it this is some other job's payload.
  if (scanned === null && started === null && blocked === null) return null;
  return {
    scanned,
    started,
    reminded: num(lastResult.reminded),
    blocked,
    cleared: num(lastResult.cleared),
    upgraded: num(lastResult.upgraded),
    errors: num(lastResult.errors),
    dryRun: bool(lastResult.dryRun),
  };
}

// ---------------------------------------------------------------------------------------------
// Download-request send outcomes
// ---------------------------------------------------------------------------------------------

/**
 * The three states a recorded send can be in.
 *
 * `not_attempted` covers two cases the rows cannot tell apart: the email was never tried (no owner
 * address on the doc, or the request never reached approval) and the send happened but the write
 * that would have stamped it failed. Both leave sentAt and error null.
 */
export type SendState = "sent" | "failed" | "not_attempted";

export type SendOutcome = {
  state: SendState;
  at: string | null;
  error: string | null;
};

/** Classify one sent-at / error pair from a ShareDownloadRequest row. */
export function sendOutcome(sentAt: string | null | undefined, error: string | null | undefined): SendOutcome {
  const at = str(sentAt);
  const err = str(error);
  if (at) return { state: "sent", at, error: err };
  if (err) return { state: "failed", at: null, error: err };
  return { state: "not_attempted", at: null, error: null };
}

/** Label for a send state, for the outcome cells. */
export function sendStateLabel(state: SendState): string {
  if (state === "sent") return "Sent";
  if (state === "failed") return "Failed";
  return "Not attempted";
}

// ---------------------------------------------------------------------------------------------
// Notification queue depth and dead letters
// ---------------------------------------------------------------------------------------------

/**
 * What the notification queue holds *now* — a different question from the run summary above.
 *
 * The run counters say what the last tick did; these say what is still owed, what went out
 * recently and what gave up. Neither question had an answer under the cursor model, which is most
 * of why the queue exists (docs/prds/lnkdrp-notification-queue.md, M4).
 *
 * `sent24h` is a window, not a lifetime total, because `sent` rows carry a 30-day TTL: a lifetime
 * count would fall as rows expire and read as mail going missing.
 */
export type NotificationQueueSummary = {
  /** Rows owed but not yet sent, whether or not they are due. */
  pending: number;
  /** Pending rows whose `nextAttemptAt` has passed — what the next tick will actually try. */
  due: number;
  /** Claimed by a runner right now. A number that stays up means a run died mid-send. */
  sending: number;
  /** Rows marked sent in the last 24 hours. */
  sent24h: number;
  /** Rows that will never be sent: the member's preference was off, or the thing is gone. */
  skipped: number;
  /** Rows that used up every attempt. Never retried automatically — they need a person. */
  dead: number;
  /** `occurredAt` of the oldest pending row: how far behind delivery is, in event time. */
  oldestPendingAt: string | null;
};

/**
 * One dead letter, as the page lists it.
 *
 * Queue fields only. The row's `event` — the document, the share link, the reader's name and
 * address — stays on the server: an admin needs to know *that* an email gave up and on which
 * error, not what it would have said (see `src/lib/admin/docPrivacy.ts`). The dedupe key names the
 * kind, the recipient and the source row, which is enough to find it in Mongo.
 */
export type DeadNotificationRow = {
  id: string;
  /** `<kind>:<userId>:<source row id>` — the queue's own identity for this email. */
  dedupeKey: string;
  kind: string;
  attempts: number;
  lastError: string | null;
  /** When the underlying thing happened. */
  occurredAt: string | null;
  /** When the row gave up — the last attempt, not the event. */
  failedAt: string | null;
};

/** A count off the wire: a non-negative integer, or 0 for anything a count cannot be. */
function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** The count keys that make a payload a queue summary rather than some other object. */
const QUEUE_COUNT_KEYS = ["pending", "due", "sending", "sent24h", "skipped", "dead"] as const;

/**
 * Narrow the queue block off an admin response.
 *
 * Returns null when the payload carries none of the counts — an older deploy, or a route that
 * failed to read the collection — so the surface says "no counts" instead of drawing a row of
 * zeros that reads as an empty queue. A payload that has some of them gets the rest as 0: a count
 * the aggregate did not report is a status with no rows in it.
 */
export function summarizeNotificationQueue(raw: unknown): NotificationQueueSummary | null {
  if (!isPlainObject(raw)) return null;
  if (!QUEUE_COUNT_KEYS.some((k) => typeof raw[k] === "number")) return null;
  return {
    pending: count(raw.pending),
    due: count(raw.due),
    sending: count(raw.sending),
    sent24h: count(raw.sent24h),
    skipped: count(raw.skipped),
    dead: count(raw.dead),
    oldestPendingAt: str(raw.oldestPendingAt),
  };
}

/** Narrow the dead-letter list off an admin response, dropping anything that is not a row. */
export function toDeadNotificationRows(raw: unknown): DeadNotificationRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: DeadNotificationRow[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const id = str(entry.id);
    const dedupeKey = str(entry.dedupeKey);
    // Without an id there is nothing to key the row on, and without a dedupe key there is nothing
    // to identify the email by — either one missing means this is not a queue row.
    if (!id || !dedupeKey) continue;
    rows.push({
      id,
      dedupeKey,
      kind: str(entry.kind) ?? "unknown",
      attempts: count(entry.attempts),
      lastError: str(entry.lastError),
      occurredAt: str(entry.occurredAt),
      failedAt: str(entry.failedAt),
    });
  }
  return rows;
}

/**
 * Queue depth as figures for the cron board's row, in the `CronStat` shape that column renders.
 *
 * Non-zero counts sort first — the same rule `cronStatsFigures` uses, and the reason the board is
 * readable at a glance: the board shows the first few, and the interesting number is the one that
 * is not zero. `dead` is the only toned figure, because it is the only one that will not clear by
 * itself.
 */
export function queueDepthFigures(summary: NotificationQueueSummary | null): CronStat[] {
  if (!summary) return [];
  const figures: CronStat[] = [
    { label: "pending", value: String(summary.pending), zero: summary.pending === 0 },
    { label: "due", value: String(summary.due), zero: summary.due === 0 },
    {
      label: "dead",
      value: String(summary.dead),
      zero: summary.dead === 0,
      tone: summary.dead > 0 ? "danger" : undefined,
    },
    { label: "sent 24h", value: String(summary.sent24h), zero: summary.sent24h === 0 },
  ];
  return [...figures.filter((f) => !f.zero), ...figures.filter((f) => f.zero)];
}
