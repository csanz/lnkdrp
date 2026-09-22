import { describe, expect, it } from "vitest";

import { buildCronRows, describeSchedule, nextRunAt } from "@/lib/admin/cronSchedule";
import { judgeCronHealth } from "@/lib/cron/jobs";

/**
 * A stored "ok" only means the last run finished. The board has to say whether the job is still
 * firing on schedule, which is what these cover.
 */
describe("cron schedules", () => {
  it("describes the shapes the product actually uses", () => {
    expect(describeSchedule("*/5 * * * *")).toBe("every 5 minutes");
    expect(describeSchedule("30 * * * *")).toBe("hourly at :30");
    expect(describeSchedule("0 */6 * * *")).toBe("every 6 hours at :00");
    expect(describeSchedule("30 4 * * *")).toBe("daily at 04:30 UTC");
  });

  it("finds the next fire time in UTC", () => {
    const from = new Date("2026-09-18T10:07:30Z");
    expect(nextRunAt("*/5 * * * *", from)?.toISOString()).toBe("2026-09-18T10:10:00.000Z");
    expect(nextRunAt("30 * * * *", from)?.toISOString()).toBe("2026-09-18T10:30:00.000Z");
    expect(nextRunAt("30 4 * * *", from)?.toISOString()).toBe("2026-09-19T04:30:00.000Z");
    // A shape the parser does not claim to understand says so instead of guessing.
    expect(nextRunAt("0 0 1 * *", from)).toBeNull();
  });
});

describe("cron state", () => {
  const now = new Date("2026-09-18T10:00:00Z");
  const jobs = [{ jobKey: "hourly", schedule: "30 * * * *", intervalMs: 60 * 60_000, what: "test job", why: "test" }] as const;

  it("an hourly job that last ran five days ago is late, not ok", () => {
    const [row] = buildCronRows([{ jobKey: "hourly", status: "ok", lastRunAt: "2026-09-13T10:00:00Z" }], now, jobs);
    expect(row.state).toBe("late");
    expect(row.detail).toContain("5 days");
  });

  it("a recent ok run is on time", () => {
    const [row] = buildCronRows([{ jobKey: "hourly", status: "ok", lastRunAt: "2026-09-18T09:30:00Z" }], now, jobs);
    expect(row.state).toBe("ok");
  });

  it("a job with no heartbeat is listed as never run, not hidden", () => {
    const [row] = buildCronRows([], now, jobs);
    expect(row.state).toBe("never");
    expect(row.jobKey).toBe("hourly");
  });

  it("a run still claiming to be running after the kill window is stalled", () => {
    const fresh = buildCronRows([{ jobKey: "hourly", status: "running", lastStartedAt: "2026-09-18T09:59:00Z" }], now, jobs)[0];
    expect(fresh.state).toBe("running");
    const dead = buildCronRows([{ jobKey: "hourly", status: "running", lastStartedAt: "2026-09-18T09:00:00Z" }], now, jobs)[0];
    expect(dead.state).toBe("stuck");
  });

  it("a failing run keeps its error as the detail", () => {
    const [row] = buildCronRows([{ jobKey: "hourly", status: "error", lastRunAt: "2026-09-18T09:30:00Z", lastError: "boom" }], now, jobs);
    expect(row.state).toBe("error");
    expect(row.detail).toBe("boom");
  });
});

/**
 * The board and /api/monitor/crons judge the same row, so they have to use the same window. The
 * board used the flat ten-minute constant, which a five-minute job never reaches: its row is
 * rewritten by the tick that takes the expired lease first. These pin the per-job window.
 */
describe("cron state for a frequent job", () => {
  const now = new Date("2026-09-18T10:00:00Z");
  const jobs = [
    { jobKey: "notification-emails", schedule: "*/5 * * * *", intervalMs: 5 * 60_000, what: "test job", why: "test" },
  ] as const;

  it("a five-minute job killed mid-run shows as stalled, not as a calm Running", () => {
    // Nine minutes is under the flat ten-minute constant and over this job's own six-minute window.
    const [row] = buildCronRows(
      [{ jobKey: "notification-emails", status: "running", lastStartedAt: "2026-09-18T09:51:00Z" }],
      now,
      jobs,
    );
    expect(row.state).toBe("stuck");
  });

  it("a run inside its own window is still running", () => {
    const [row] = buildCronRows(
      [{ jobKey: "notification-emails", status: "running", lastStartedAt: "2026-09-18T09:55:00Z" }],
      now,
      jobs,
    );
    expect(row.state).toBe("running");
  });

  it("agrees with the monitor about the same row", () => {
    const row = { jobKey: "notification-emails", status: "running", lastStartedAt: "2026-09-18T09:51:00Z" };
    expect(buildCronRows([row], now, jobs)[0].state).toBe("stuck");
    expect(judgeCronHealth({ rows: [row], now: now.getTime(), jobs }).jobs[0].state).toBe("stuck");
  });
});
