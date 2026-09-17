/**
 * The cron jobs, their production schedules, and how late each may be before something is wrong.
 *
 * `vercel.json` is the schedule's source of truth, but a deployed function cannot read it — it is
 * configuration for the platform, not a traced file. So the schedules are repeated here and
 * `tests/lib/cronMap.test.ts` fails if the two ever disagree, the same way it already guards the
 * route, the runner script and the npm alias.
 *
 * `intervalMs` is the schedule's own period, written out rather than derived: a general cron parser
 * would be more code than this list and would have to be trusted. The monitor allows two of them
 * before calling a job late, which matches the threshold the runbook tells operators to treat as an
 * incident. Keep the three columns in step when a schedule changes.
 */
export type CronJobSpec = {
  /** `CronHealth.jobKey`, the route segment, and the runner script's name. */
  jobKey: string;
  /** Must equal this job's `schedule` in `vercel.json`. UTC. */
  schedule: string;
  /** How often the schedule fires, in milliseconds. */
  intervalMs: number;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const CRON_JOBS: readonly CronJobSpec[] = [
  { jobKey: "doc-metrics", schedule: "0 */6 * * *", intervalMs: 6 * HOUR },
  { jobKey: "stripe-credits-reconcile", schedule: "15 */6 * * *", intervalMs: 6 * HOUR },
  { jobKey: "stripe-credits-report", schedule: "30 * * * *", intervalMs: 1 * HOUR },
  { jobKey: "credits-cycle-reconcile", schedule: "10 * * * *", intervalMs: 1 * HOUR },
  { jobKey: "usage-agg-reconcile", schedule: "20 * * * *", intervalMs: 1 * HOUR },
  { jobKey: "notification-emails", schedule: "*/5 * * * *", intervalMs: 5 * MINUTE },
  { jobKey: "plan-limits", schedule: "40 * * * *", intervalMs: 1 * HOUR },
  { jobKey: "analytics-reconcile", schedule: "50 3 * * *", intervalMs: 24 * HOUR },
  { jobKey: "credits-purchase-expiry", schedule: "5 4 * * *", intervalMs: 24 * HOUR },
] as const;

/** How many whole intervals a job may miss before the monitor calls it late. */
export const LATE_AFTER_INTERVALS = 2;

/**
 * A run that says `running` this long after it started did not finish — the function was killed,
 * usually at the 300 s limit, before it could write a result. The overlap lease expires after six
 * minutes, so ten leaves room for a slow finish without hiding a dead run.
 */
export const RUNNING_STUCK_AFTER_MS = 10 * MINUTE;

/** Slack past one interval before a frequent job's `running` row counts as dead. */
export const STUCK_MARGIN_MS = 1 * MINUTE;

/**
 * How long a run may say `running` before it is `stuck`. For a job that fires every five minutes,
 * ten minutes is never reached: the tick after the six-minute lease expires restarts the row first,
 * so a job killed every run would never show stuck. One interval plus a minute is still past the
 * 300 s function limit, and it is crossed before the next run can take the lease.
 */
export function stuckAfterMs(job: CronJobSpec): number {
  return Math.min(RUNNING_STUCK_AFTER_MS, job.intervalMs + STUCK_MARGIN_MS);
}

export type CronJobHealth = {
  jobKey: string;
  schedule: string;
  /**
   * - `ok` — ran within its window and reported success
   * - `error` — its last run reported an error
   * - `late` — no run for more than {@link LATE_AFTER_INTERVALS} intervals (for a row at `running`,
   *   no *finished* run for that long plus {@link stuckAfterMs})
   * - `stuck` — left at `running`, so the function died mid-run
   * - `never-run` — no `CronHealth` row at all
   */
  state: "ok" | "error" | "late" | "stuck" | "never-run";
  lastRunAt: string | null;
  lastFinishedAt: string | null;
  /** Whole seconds since `lastRunAt`, or null when it has never run. */
  ageSeconds: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
};

/** Shape of a `CronHealth` row, as much of it as the monitor reads. */
export type CronHealthRowLike = {
  jobKey?: unknown;
  status?: unknown;
  lastRunAt?: unknown;
  lastStartedAt?: unknown;
  lastFinishedAt?: unknown;
  lastDurationMs?: unknown;
  lastError?: unknown;
};

/** Read a value that may be a `Date`, an ISO string, or absent. */
function asDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

/**
 * Judge every job against its schedule.
 *
 * Pure, so the states can be tested without a database or a clock. `rows` may hold rows for jobs
 * that no longer exist; they are ignored, because what matters is that every *expected* job is
 * accounted for — a job whose route was deleted stops being monitored by disappearing from
 * {@link CRON_JOBS}, not by leaving a stale row behind.
 */
export function judgeCronHealth(params: {
  rows: readonly CronHealthRowLike[];
  now: number;
  jobs?: readonly CronJobSpec[];
}): { healthy: boolean; jobs: CronJobHealth[] } {
  const jobs = params.jobs ?? CRON_JOBS;
  const byKey = new Map<string, CronHealthRowLike>();
  for (const row of params.rows) {
    const key = typeof row?.jobKey === "string" ? row.jobKey : null;
    if (key) byKey.set(key, row);
  }

  const results = jobs.map((job): CronJobHealth => {
    const row = byKey.get(job.jobKey);
    const lastRunAt = asDate(row?.lastRunAt);
    const lastFinishedAt = asDate(row?.lastFinishedAt);
    const ageMs = lastRunAt ? params.now - lastRunAt.getTime() : null;
    const lastError = typeof row?.lastError === "string" && row.lastError ? row.lastError : null;
    const lastDurationMs =
      typeof row?.lastDurationMs === "number" && Number.isFinite(row.lastDurationMs) ? row.lastDurationMs : null;

    const base = {
      jobKey: job.jobKey,
      schedule: job.schedule,
      lastRunAt: lastRunAt ? lastRunAt.toISOString() : null,
      lastFinishedAt: lastFinishedAt ? lastFinishedAt.toISOString() : null,
      ageSeconds: ageMs === null ? null : Math.max(0, Math.floor(ageMs / 1000)),
      lastDurationMs,
      lastError,
    };

    if (!row) return { ...base, state: "never-run" };

    // A run stuck at `running` is reported as itself rather than as `late`: the two have different
    // fixes, and a stuck run can still be inside its schedule window.
    if (row.status === "running") {
      const startedAt = asDate(row.lastStartedAt);
      const runningMs = startedAt ? params.now - startedAt.getTime() : null;
      if (runningMs !== null && runningMs > stuckAfterMs(job)) return { ...base, state: "stuck" };

      // `lastRunAt` moves when a run starts, so a job killed mid-run every time keeps it fresh.
      // Judge a running row by its last finished run instead; the extra stuck window covers a
      // legitimate run in progress.
      const finishedRef = lastFinishedAt ?? lastRunAt;
      if (finishedRef && params.now - finishedRef.getTime() > job.intervalMs * LATE_AFTER_INTERVALS + stuckAfterMs(job)) {
        return { ...base, state: "late" };
      }
    }

    if (row.status === "error") return { ...base, state: "error" };
    if (ageMs === null) return { ...base, state: "never-run" };
    if (ageMs > job.intervalMs * LATE_AFTER_INTERVALS) return { ...base, state: "late" };
    return { ...base, state: "ok" };
  });

  return { healthy: results.every((r) => r.state === "ok"), jobs: results };
}
