/**
 * What a background job's state actually is, from its schedule and its last heartbeat.
 *
 * A stored `status: "ok"` only says the last run finished. It says nothing about whether the job is
 * still running on time: an hourly job whose last "ok" was five days ago is not ok, it has stopped
 * firing, and the board showed it in the same quiet grey as a job that ran a minute ago. The state
 * here is the combination — schedule, last run, and how long a run may claim to be running before
 * it is presumed dead.
 *
 * Jobs are also listed from the registry rather than from the heartbeats, so a job that has never
 * run appears as "never run" instead of being invisible. In local development nothing fires on its
 * own (Vercel Cron only runs against a deployment), which is why a fresh database shows most jobs
 * in that state.
 */
import { CRON_JOBS, LATE_AFTER_INTERVALS, stuckAfterMs, type CronJobSpec } from "@/lib/cron/jobs";
import type { AdminTone } from "./ui";

export type CronState = "running" | "stuck" | "ok" | "late" | "error" | "never";

export type CronRow = {
  jobKey: string;
  schedule: string;
  scheduleLabel: string;
  /** What the job does, and why it exists (from the registry). */
  what: string;
  why: string;
  intervalMs: number;
  state: CronState;
  /** Why the state is what it is, in one line. */
  detail: string;
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  lastResult: unknown;
  nextRunAt: string | null;
  /** How overdue the job is, in ms, when `late`. */
  overdueMs: number | null;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** "every 5 minutes", "hourly at :30", "every 6 hours", "daily at 04:30 UTC". */
export function describeSchedule(expr: string): string {
  const [min, hour] = expr.trim().split(/\s+/);
  if (!min || !hour) return expr;
  const everyMin = min.startsWith("*/") ? Number(min.slice(2)) : null;
  const everyHour = hour.startsWith("*/") ? Number(hour.slice(2)) : null;
  if (everyMin && hour === "*") return `every ${everyMin} minutes`;
  if (hour === "*") return `hourly at :${String(min).padStart(2, "0")}`;
  if (everyHour) return `every ${everyHour} hours at :${String(min).padStart(2, "0")}`;
  const h = Number(hour);
  if (Number.isFinite(h)) return `daily at ${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")} UTC`;
  return expr;
}

/**
 * The next UTC time this expression fires, for the shapes the product uses: minute and hour fields,
 * each either a fixed number or a step ("every n"), running every day. Returns null for anything
 * else rather than guessing.
 */
export function nextRunAt(expr: string, from: Date = new Date()): Date | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  if (dom !== "*" || mon !== "*" || dow !== "*") return null;

  const minutes: number[] = min.startsWith("*/")
    ? Array.from({ length: Math.ceil(60 / Number(min.slice(2))) }, (_, i) => i * Number(min.slice(2))).filter((m) => m < 60)
    : Number.isFinite(Number(min))
      ? [Number(min)]
      : [];
  const hours: number[] = hour === "*"
    ? Array.from({ length: 24 }, (_, i) => i)
    : hour.startsWith("*/")
      ? Array.from({ length: Math.ceil(24 / Number(hour.slice(2))) }, (_, i) => i * Number(hour.slice(2))).filter((h) => h < 24)
      : Number.isFinite(Number(hour))
        ? [Number(hour)]
        : [];
  if (!minutes.length || !hours.length) return null;

  // Walk forward from the next minute; at most two days of candidates, which is cheap and exact.
  const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), from.getUTCHours(), from.getUTCMinutes()) + MINUTE);
  for (let i = 0; i < 2 * 24 * 60; i++) {
    const t = new Date(start.getTime() + i * MINUTE);
    if (hours.includes(t.getUTCHours()) && minutes.includes(t.getUTCMinutes())) return t;
  }
  return null;
}

/** A state as a tone: only what needs attention gets colour. */
export function cronStateTone(state: CronState): AdminTone {
  if (state === "error" || state === "stuck") return "danger";
  if (state === "late") return "warning";
  if (state === "running") return "info";
  if (state === "never") return "neutral";
  return "quiet";
}

export function cronStateLabel(state: CronState): string {
  switch (state) {
    case "running":
      return "Running";
    case "stuck":
      return "Stalled";
    case "late":
      return "Late";
    case "error":
      return "Failing";
    case "never":
      return "Never run";
    default:
      return "On time";
  }
}

/** "4 minutes ago", "2 hours ago", "5 days ago". */
export function since(ms: number): string {
  const m = Math.round(ms / MINUTE);
  if (m < 1) return "just now";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

export type HeartbeatLike = {
  jobKey?: string;
  status?: string | null;
  lastRunAt?: string | null;
  lastStartedAt?: string | null;
  lastDurationMs?: number | null;
  lastError?: string | null;
  lastResult?: unknown;
};

function toDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** Every registered job, in schedule order, with the state its heartbeat and schedule imply. */
export function buildCronRows(heartbeats: HeartbeatLike[], now: Date = new Date(), jobs: readonly CronJobSpec[] = CRON_JOBS): CronRow[] {
  const byKey = new Map(heartbeats.filter((h) => h.jobKey).map((h) => [String(h.jobKey), h]));
  return jobs.map((spec) => {
    const hb = byKey.get(spec.jobKey);
    const lastRun = toDate(hb?.lastRunAt ?? null);
    const startedAt = toDate(hb?.lastStartedAt ?? null);
    const ageMs = lastRun ? now.getTime() - lastRun.getTime() : null;
    const lateAfterMs = spec.intervalMs * LATE_AFTER_INTERVALS;

    let state: CronState;
    let detail: string;
    // `running` is checked before `lastRunAt`: a job that started and never finished has only a
    // start time, and testing for the finish first reported an in-flight run as "never run".
    if (!hb) {
      state = "never";
      detail = "No run recorded on this deployment";
    } else if (hb.status === "running") {
      const runningFor = startedAt ? now.getTime() - startedAt.getTime() : 0;
      // The window is the job's own, not the flat ten minutes. This board used the flat constant
      // while /api/monitor/crons already used `stuckAfterMs`, and the two disagreed about the only
      // job that matters here: notification-emails fires every five minutes, so its row is rewritten
      // by the tick that takes the expired six-minute lease before `runningFor` can ever pass ten
      // minutes. An operator reading this board saw a permanently dying email sender sitting in a
      // calm blue "Running" and concluded it was working, while the monitor was calling it stuck.
      // Asking the registry for the window keeps the two surfaces in step when a schedule changes.
      if (runningFor > stuckAfterMs(spec)) {
        state = "stuck";
        detail = `Claimed running for ${since(runningFor)}. The function was probably killed mid-run`;
      } else {
        state = "running";
        detail = startedAt ? `Started ${since(runningFor)} ago` : "Started just now";
      }
    } else if (!lastRun) {
      state = "never";
      detail = "No run recorded on this deployment";
    } else if (hb.status === "error") {
      state = "error";
      detail = hb.lastError ? String(hb.lastError).slice(0, 160) : "Last run failed";
    } else if (ageMs !== null && ageMs > lateAfterMs) {
      state = "late";
      detail = `Last ran ${since(ageMs)} ago; ${describeSchedule(spec.schedule)}`;
    } else {
      state = "ok";
      detail = ageMs !== null ? `Ran ${since(ageMs)} ago` : "Ran recently";
    }

    const next = nextRunAt(spec.schedule, now);
    return {
      jobKey: spec.jobKey,
      schedule: spec.schedule,
      scheduleLabel: describeSchedule(spec.schedule),
      what: spec.what,
      why: spec.why,
      intervalMs: spec.intervalMs,
      state,
      detail,
      lastRunAt: lastRun ? lastRun.toISOString() : null,
      lastDurationMs: typeof hb?.lastDurationMs === "number" ? hb.lastDurationMs : null,
      lastError: hb?.lastError ? String(hb.lastError) : null,
      lastResult: hb?.lastResult ?? null,
      nextRunAt: next ? next.toISOString() : null,
      overdueMs: state === "late" && ageMs !== null ? ageMs - spec.intervalMs : null,
    };
  });
}
