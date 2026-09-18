/**
 * Admin route: `/a/cron-health`
 *
 * The latest heartbeat each cron job wrote. One snapshot per job, overwritten every tick, so
 * this is a status board and not a history: the table is one line per job, and anything that
 * is failing is lifted out above it where an admin will actually see it.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import Button from "@/components/ui/Button";
import {
  AdminAlert,
  AdminAccessState,
  AdminFilterBar,
  AdminPageHeader,
  AdminTable,
  AdminTableMessage,
  AdminTd,
  AdminTh,
  AdminTr,
  StatusPill,
  TimeCell,
  useAdminAccess,
} from "@/components/admin";
import { ADMIN_DASH, toneTextStyle } from "@/lib/admin/ui";
import { cronStatsFigures, formatCronStatsLine, type CronHealthItem } from "@/lib/admin/cronHealth";
import { buildCronRows, cronStateLabel, cronStateTone, since, type CronRow } from "@/lib/admin/cronSchedule";
import { fmtDuration } from "@/lib/admin/format";
import { ADMIN_PAGE_CONTAINER } from "@/lib/admin/layout";
import { fetchJson } from "@/lib/http/fetchJson";

const COLUMN_COUNT = 7;

/** The cron health board: one row per job, failures called out above the table. */
export default function CronHealthAdminPage() {
  const access = useAdminAccess();
  const canUseAdmin = access.canUseAdmin;

  const [health, setHealth] = useState<CronHealthItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalized = useMemo(() => (Array.isArray(health) ? health : []), [health]);
  // Rows come from the job registry, not the heartbeats: a job that has never run has no snapshot,
  // and leaving it out is how five of the ten scheduled jobs were invisible on this board.
  const rows: CronRow[] = useMemo(() => buildCronRows(normalized), [normalized]);
  const byKey = useMemo(() => new Map(normalized.map((i) => [i.jobKey, i])), [normalized]);
  const failing = useMemo(() => rows.filter((r) => r.state === "error" || r.state === "stuck"), [rows]);
  const late = useMemo(() => rows.filter((r) => r.state === "late"), [rows]);

  /** Read the current snapshots. */
  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson<{ items?: unknown }>("/api/admin/cron-health?limit=50", { method: "GET" });
      setHealth(Array.isArray(data.items) ? (data.items as CronHealthItem[]) : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load cron health");
      setHealth([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!canUseAdmin) return;
    void load();
  }, [canUseAdmin]);

  if (!canUseAdmin) {
    return <AdminAccessState access={access} title="Cron health" description="Every scheduled job, its state against its own schedule, and the last heartbeat it wrote." callbackUrl="/a/cron-health" />;
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className={ADMIN_PAGE_CONTAINER}>
        <AdminPageHeader
          title="Cron health"
          description="Every scheduled job, its state against its own schedule, and the last heartbeat it wrote."
        />

        {/* The band has no filters to carry, but it still reads the count the way every other
            list page does — "1–5 of 5 jobs" — instead of a sentence of its own invention. */}
        <AdminFilterBar
          className="mt-4"
          page={1}
          pageSize={Math.max(1, rows.length)}
          total={rows.length}
          noun="jobs"
          loading={loading}
          actions={
            <Button variant="outline" onClick={() => void load()} disabled={loading}>
              {loading ? "Loading…" : "Refresh"}
            </Button>
          }
        />

        {error ? (
          <AdminAlert className="mt-3">
            {error}
          </AdminAlert>
        ) : null}

        {failing.length ? (
          <AdminAlert className="mt-3">
            <div className="font-semibold">
              {failing.length} {failing.length === 1 ? "job is" : "jobs are"} failing
            </div>
            <div className="mt-1 grid gap-1">
              {failing.map((row) => (
                <div key={row.jobKey}>
                  <span className="font-mono text-[12px]">{row.jobKey}</span>
                  {row.detail ? <> — {row.detail}</> : null}
                </div>
              ))}
            </div>
          </AdminAlert>
        ) : null}

        {late.length ? (
          <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3 text-[12px] leading-5 text-[var(--muted-2)]">
            <span className="font-semibold text-[var(--fg)]">
              {late.length} {late.length === 1 ? "job is" : "jobs are"} late
            </span>{" "}
            — they last ran longer ago than two of their own intervals. On a local machine that is normal: Vercel Cron only
            fires against a deployment, so nothing here runs on its own until it is deployed.
          </div>
        ) : null}

        <AdminTable
          className="mt-3"
          ariaLabel="Cron jobs"
          head={
            <>
              <AdminTh>Job</AdminTh>
              <AdminTh>State</AdminTh>
              <AdminTh>Schedule</AdminTh>
              <AdminTh align="right">Last run</AdminTh>
              <AdminTh align="right">Next run</AdminTh>
              <AdminTh align="right">Duration</AdminTh>
              <AdminTh>Last result</AdminTh>
            </>
          }
        >
          {loading && rows.length === 0 ? (
            <AdminTableMessage colSpan={COLUMN_COUNT}>Loading cron health…</AdminTableMessage>
          ) : (
            rows.map((row) => {
              const item = byKey.get(row.jobKey);
              const stats = item ? formatCronStatsLine(item) : null;
              const figures = item ? cronStatsFigures(item) : [];
              return (
                <AdminTr key={row.jobKey}>
                  {/* Two lines here on purpose: a job key alone says nothing about what stopping it
                      would break, and that is the question this board is opened with. */}
                  <AdminTd primary truncate="max-w-[300px]">
                    <span className="font-mono" title={row.jobKey}>
                      {row.jobKey}
                    </span>
                    <span className="block truncate text-[12px] font-normal leading-4 text-[var(--muted-2)]" title={`${row.what} ${row.why}`}>
                      {row.what}
                    </span>
                  </AdminTd>
                  <AdminTd>
                    {/* The dot pulses only while a run is in flight: a board of static dots says
                        nothing, and a moving one is how you see the job is actually working. */}
                    <StatusPill tone={cronStateTone(row.state)} dot={row.state !== "error" && row.state !== "stuck"}>
                      <span className={row.state === "running" ? "motion-safe:animate-pulse" : undefined}>
                        {cronStateLabel(row.state)}
                      </span>
                    </StatusPill>
                  </AdminTd>
                  <AdminTd truncate="max-w-[200px]">
                    <span title={row.schedule}>{row.scheduleLabel}</span>
                  </AdminTd>
                  <AdminTd align="right" numeric>
                    {row.lastRunAt ? <TimeCell value={row.lastRunAt} /> : ADMIN_DASH}
                  </AdminTd>
                  <AdminTd align="right" numeric>
                    {row.nextRunAt ? (
                      <span title={new Date(row.nextRunAt).toLocaleString()}>
                        in {since(new Date(row.nextRunAt).getTime() - Date.now())}
                      </span>
                    ) : (
                      ADMIN_DASH
                    )}
                  </AdminTd>
                  <AdminTd align="right" numeric>
                    {fmtDuration(row.lastDurationMs) || ADMIN_DASH}
                  </AdminTd>
                  <AdminTd truncate="max-w-[420px]">
                    {row.state === "error" || row.state === "stuck" || row.state === "late" || row.state === "never" ? (
                      <span
                        style={row.state === "error" || row.state === "stuck" ? toneTextStyle("danger") : undefined}
                        className={row.state === "late" || row.state === "never" ? "text-[var(--muted-2)]" : undefined}
                        title={row.detail}
                      >
                        {row.detail}
                      </span>
                    ) : figures.length ? (
                      <span className="inline-flex items-baseline gap-3" title={stats ?? undefined}>
                        {figures.slice(0, 3).map((f) => (
                          <span key={f.label} className="inline-flex items-baseline gap-1">
                            <span className="text-[var(--muted-2)]">{f.label}</span>
                            <span className="tabular-nums text-[var(--fg)]">{f.value}</span>
                          </span>
                        ))}
                        {figures.length > 3 ? <span className="text-[var(--muted-2)]">+{figures.length - 3} more</span> : null}
                      </span>
                    ) : (
                      <span className="text-[var(--muted-2)]">{row.detail}</span>
                    )}
                  </AdminTd>
                </AdminTr>
              );
            })
          )}
        </AdminTable>
      </div>
    </div>
  );
}
