import { describe, expect, test } from "vitest";

import { CRON_JOBS, judgeCronHealth, type CronJobSpec } from "@/lib/cron/jobs";

/**
 * What `GET /api/monitor/crons` turns into a 200 or a 503.
 *
 * The judgement is pure so these need no database and no clock: `now` is passed in, which is also
 * the only way to test "late" without waiting six hours.
 */
const NOW = Date.parse("2026-09-15T12:00:00.000Z");
const HOUR = 3_600_000;

/** Two jobs with round numbers, so the arithmetic in each case is obvious. */
const JOBS: CronJobSpec[] = [
  { jobKey: "hourly", schedule: "0 * * * *", intervalMs: HOUR, what: "an hourly job", why: "test fixture" },
  { jobKey: "daily", schedule: "0 3 * * *", intervalMs: 24 * HOUR, what: "a daily job", why: "test fixture" },
];

/** A healthy row for `jobKey`, last run `minutesAgo` ago. */
function row(jobKey: string, minutesAgo: number, extra: Record<string, unknown> = {}) {
  return {
    jobKey,
    status: "ok",
    lastRunAt: new Date(NOW - minutesAgo * 60_000),
    lastStartedAt: new Date(NOW - minutesAgo * 60_000),
    lastDurationMs: 1234,
    lastError: null,
    ...extra,
  };
}

const judge = (rows: ReturnType<typeof row>[]) => judgeCronHealth({ rows, now: NOW, jobs: JOBS });
const state = (rows: ReturnType<typeof row>[], jobKey: string) =>
  judge(rows).jobs.find((j) => j.jobKey === jobKey)?.state;

describe("judgeCronHealth", () => {
  test("every job inside its window is healthy", () => {
    const result = judge([row("hourly", 10), row("daily", 60)]);

    expect(result.healthy).toBe(true);
    expect(result.jobs.map((j) => j.state)).toEqual(["ok", "ok"]);
  });

  test("a job is late only after two whole intervals, not one", () => {
    expect(state([row("hourly", 90), row("daily", 60)], "hourly")).toBe("ok");
    expect(state([row("hourly", 121), row("daily", 60)], "hourly")).toBe("late");
  });

  test("each job is judged against its own schedule", () => {
    // 6 hours is long past late for the hourly job and well inside the daily one's window.
    const rows = [row("hourly", 360), row("daily", 360)];

    expect(state(rows, "hourly")).toBe("late");
    expect(state(rows, "daily")).toBe("ok");
  });

  test("a job that reported an error is unhealthy even though it just ran", () => {
    const rows = [row("hourly", 1, { status: "error", lastError: "boom" }), row("daily", 60)];

    expect(state(rows, "hourly")).toBe("error");
    expect(judge(rows).healthy).toBe(false);
    expect(judge(rows).jobs[0].lastError).toBe("boom");
  });

  test("a run left at `running` is stuck, but only once it outlives the lease", () => {
    const stillGoing = [row("hourly", 3, { status: "running" }), row("daily", 60)];
    const died = [row("hourly", 30, { status: "running" }), row("daily", 60)];

    expect(state(stillGoing, "hourly")).toBe("ok");
    expect(state(died, "hourly")).toBe("stuck");
  });

  test("stuck is reported as itself, not as late", () => {
    // Inside its window, so nothing about the timing is wrong — only the unfinished run is.
    expect(state([row("hourly", 20, { status: "running" }), row("daily", 60)], "hourly")).toBe("stuck");
  });

  describe("a frequent job killed mid-run every time", () => {
    // Every five minutes; killed at 300 s. The six-minute lease makes the next tick skip, and the
    // one after restarts the row, so `lastRunAt` and `lastStartedAt` never get old.
    const FIVE = [{ jobKey: "five", schedule: "*/5 * * * *", intervalMs: 5 * 60_000, what: "a five-minute job", why: "test fixture" }];
    const judgeFive = (r: ReturnType<typeof row>) => judgeCronHealth({ rows: [r], now: NOW, jobs: FIVE }).jobs[0];

    /** A row at `running`, started `startedAgo` minutes ago, last finished `finishedAgo` minutes ago. */
    const running = (startedAgo: number, finishedAgo: number | null) =>
      row("five", startedAgo, {
        status: "running",
        lastFinishedAt: finishedAgo === null ? null : new Date(NOW - finishedAgo * 60_000),
      });

    test("is stuck once a run outlives one interval plus the margin, before the lease lets a new run in", () => {
      expect(judgeFive(running(7, 12)).state).toBe("stuck");
    });

    test("is late from its last finished run even while a fresh run is starting", () => {
      // Restarted a minute ago, so neither lastRunAt nor lastStartedAt looks old.
      expect(judgeFive(running(1, 25))).toMatchObject({ state: "late", ageSeconds: 60 });
    });

    test("a legitimate run in progress stays ok", () => {
      // Previous run finished just before this one started 4 minutes ago.
      expect(judgeFive(running(4, 4.5)).state).toBe("ok");
      // Late tick plus a slow run: still inside two intervals plus the stuck window.
      expect(judgeFive(running(5, 14)).state).toBe("ok");
    });

    test("reports lastFinishedAt so the alert reader sees why", () => {
      expect(judgeFive(running(1, 25)).lastFinishedAt).toBe(new Date(NOW - 25 * 60_000).toISOString());
    });
  });

  test("hourly jobs keep the ten-minute stuck threshold", () => {
    expect(state([row("hourly", 9, { status: "running" }), row("daily", 60)], "hourly")).toBe("ok");
    expect(state([row("hourly", 11, { status: "running" }), row("daily", 60)], "hourly")).toBe("stuck");
  });

  test("a job with no row at all is never-run, not silently healthy", () => {
    const result = judge([row("hourly", 10)]);

    expect(result.healthy).toBe(false);
    expect(result.jobs.find((j) => j.jobKey === "daily")).toMatchObject({
      state: "never-run",
      lastRunAt: null,
      ageSeconds: null,
    });
  });

  test("a row for a job that no longer exists is ignored", () => {
    const result = judge([row("hourly", 10), row("daily", 60), row("deleted-job", 10_000)]);

    expect(result.healthy).toBe(true);
    expect(result.jobs).toHaveLength(2);
  });

  test("reports age in whole seconds and the schedule it was judged against", () => {
    const result = judge([row("hourly", 5), row("daily", 60)]);

    expect(result.jobs[0]).toMatchObject({ ageSeconds: 300, schedule: "0 * * * *", lastDurationMs: 1234 });
  });

  test("tolerates an ISO string where mongo would give a Date", () => {
    const rows = [
      { ...row("hourly", 5), lastRunAt: new Date(NOW - 5 * 60_000).toISOString() },
      row("daily", 60),
    ] as ReturnType<typeof row>[];

    expect(state(rows, "hourly")).toBe("ok");
  });

  test("the real job list is judged the same way", () => {
    const rows = CRON_JOBS.map((j) => ({ ...row(j.jobKey, 1) }));

    const result = judgeCronHealth({ rows, now: NOW });

    expect(result.healthy).toBe(true);
    expect(result.jobs).toHaveLength(CRON_JOBS.length);
  });
});
