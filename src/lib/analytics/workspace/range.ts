/**
 * The `?range=` parameter, the plan clamp and the previous-period window. Pure: no database.
 *
 * The window itself is `windowStartUtc` from `src/lib/analytics/shareViewAggregates.ts` — the same
 * function the document metrics route uses — so "last 30 days" means the same instant on both
 * pages and a per-document row can be compared with its own page.
 */
import { windowStartUtc } from "@/lib/analytics/shareViewAggregates";
import { clampAnalyticsDays, limitsForPlan, type PlanId } from "@/lib/billing/planLimits";

import {
  WORKSPACE_DEFAULT_RANGE,
  WORKSPACE_RANGE_DAYS,
  WORKSPACE_RANGE_KEYS,
  type WorkspaceRange,
  type WorkspaceRangeKey,
} from "./types";

/**
 * Whether a Free workspace is given the previous period as well as the current one.
 *
 * `false`, and deliberately: comparing the last 7 days with the 7 before them reads rows from 8-14
 * days ago, which is outside the window Free is sold. A percentage is still a reading of data the
 * plan does not include, so Free gets `previous: null` and the UI simply omits the comparison. Flip
 * this one constant if the product decides a delta is not "history".
 */
export const WORKSPACE_PREVIOUS_ON_FREE = false;

/** `?range=`: one of the three keys, defaulting to 30 days for anything else. */
export function parseWorkspaceRangeKey(raw: string | null | undefined): WorkspaceRangeKey {
  const v = (raw ?? "").trim().toLowerCase();
  return (WORKSPACE_RANGE_KEYS as readonly string[]).includes(v) ? (v as WorkspaceRangeKey) : WORKSPACE_DEFAULT_RANGE;
}

/** The UTC day key (`YYYY-MM-DD`) an instant falls on. */
export function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** `days` UTC day keys starting at `start`, in order — the x-axis of the hero chart. */
export function dayKeysFrom(start: Date, days: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.max(0, Math.floor(days)); i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    out.push(utcDayKey(d));
  }
  return out;
}

/** The window a resolved range covers, in the form the Mongo matches want. */
export type ResolvedWorkspaceRange = {
  range: WorkspaceRange;
  /** Inclusive lower bound of the served window. */
  start: Date;
  /** Exclusive upper bound of the previous window (== `start`), `null` when none is served. */
  previousEnd: Date | null;
  /** Inclusive lower bound of the previous window, `null` when none is served. */
  previousStart: Date | null;
  /** Day keys of the served window, in order. */
  dayKeys: string[];
};

/**
 * Resolve `?range=` against the plan.
 *
 * Free is clamped silently and told about it (`clampedByPlan`), the pattern every other analytics
 * route follows: the server serves what the plan allows and the client snaps its control to it,
 * rather than a 402 that would leave the page blank. `key` labels the served window when the
 * clamped day count happens to match one of the three ranges, which is the only case today
 * (`FREE_ANALYTICS_DAYS` is 7); otherwise `days` is the authoritative figure.
 */
export function resolveWorkspaceRange(o: {
  requested: WorkspaceRangeKey;
  plan: PlanId;
  now?: Date;
}): ResolvedWorkspaceRange {
  const now = o.now ?? new Date();
  const requestedDays = WORKSPACE_RANGE_DAYS[o.requested];
  const days = clampAnalyticsDays(o.plan, requestedDays);
  const clampedByPlan = days < requestedDays;
  const key = WORKSPACE_RANGE_KEYS.find((k) => WORKSPACE_RANGE_DAYS[k] === days) ?? o.requested;

  const start = windowStartUtc(days, now);
  const dayKeys = dayKeysFrom(start, days);

  const wantsPrevious = o.plan === "pro" || WORKSPACE_PREVIOUS_ON_FREE;
  // The same length again, ending where the current window begins: [prevStart, start).
  const previousStart = wantsPrevious ? windowStartUtc(days * 2, now) : null;
  const previousEnd = wantsPrevious ? start : null;

  return {
    range: {
      key,
      requested: o.requested,
      start: dayKeys[0] ?? utcDayKey(start),
      end: dayKeys[dayKeys.length - 1] ?? utcDayKey(start),
      days,
      clampedByPlan,
      previous:
        previousStart && previousEnd
          ? {
              start: utcDayKey(previousStart),
              end: utcDayKey(new Date(previousEnd.getTime() - 86_400_000)),
            }
          : null,
    },
    start,
    previousStart,
    previousEnd,
    dayKeys,
  };
}

/** What the payload reports about the plan itself. */
export function workspacePlanInfo(plan: PlanId): { isPro: boolean; analyticsDays: number | null } {
  return { isPro: plan === "pro", analyticsDays: limitsForPlan(plan).analyticsDays };
}
