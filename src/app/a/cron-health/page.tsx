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
  AdminTableEmpty,
  AdminTableMessage,
  AdminTd,
  AdminTh,
  AdminTr,
  StatusPill,
  TimeCell,
  useAdminAccess,
} from "@/components/admin";
import { ADMIN_DASH, toneTextStyle } from "@/lib/admin/ui";
import { cronStatsFigures, cronTone, formatCronStatsLine, type CronHealthItem } from "@/lib/admin/cronHealth";
import { fmtDuration } from "@/lib/admin/format";
import { ADMIN_PAGE_CONTAINER } from "@/lib/admin/layout";
import { fetchJson } from "@/lib/http/fetchJson";

const COLUMN_COUNT = 5;

/** The cron health board: one row per job, failures called out above the table. */
export default function CronHealthAdminPage() {
  const access = useAdminAccess();
  const canUseAdmin = access.canUseAdmin;

  const [health, setHealth] = useState<CronHealthItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalized = useMemo(() => (Array.isArray(health) ? health : []), [health]);
  const failing = useMemo(() => normalized.filter((i) => i.status === "error"), [normalized]);

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
    return <AdminAccessState access={access} title="Cron health" description="The last heartbeat from every background job. One snapshot per job, overwritten each tick." callbackUrl="/a/cron-health" />;
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className={ADMIN_PAGE_CONTAINER}>
        <AdminPageHeader
          title="Cron health"
          description="The last heartbeat from every background job. One snapshot per job, overwritten each tick."
        />

        {/* The band has no filters to carry, but it still reads the count the way every other
            list page does — "1–5 of 5 jobs" — instead of a sentence of its own invention. */}
        <AdminFilterBar
          className="mt-4"
          page={1}
          pageSize={Math.max(1, normalized.length)}
          total={normalized.length}
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
              {failing.map((item) => (
                <div key={item.jobKey}>
                  <span className="font-mono text-[12px]">{item.jobKey}</span>
                  {item.lastError ? <> — {item.lastError}</> : null}
                </div>
              ))}
            </div>
          </AdminAlert>
        ) : null}

        <AdminTable
          className="mt-3"
          ariaLabel="Cron jobs"
          head={
            <>
              <AdminTh>Job</AdminTh>
              <AdminTh>Status</AdminTh>
              <AdminTh align="right">Last run</AdminTh>
              <AdminTh align="right">Duration</AdminTh>
              <AdminTh>Last result</AdminTh>
            </>
          }
        >
          {loading && normalized.length === 0 ? (
            <AdminTableMessage colSpan={COLUMN_COUNT}>Loading cron health…</AdminTableMessage>
          ) : normalized.length === 0 ? (
            <AdminTableEmpty
              colSpan={COLUMN_COUNT}
              title="No health snapshots yet"
              hint="Cron writes a snapshot on its first run; none has run on this deployment."
            />
          ) : (
            normalized.map((item) => {
              const stats = formatCronStatsLine(item);
              const figures = cronStatsFigures(item);
              const errored = item.status === "error";
              return (
                <AdminTr key={item.jobKey}>
                  <AdminTd primary mono truncate="max-w-[220px]">
                    <span title={item.jobKey}>{item.jobKey}</span>
                  </AdminTd>
                  <AdminTd>
                    <StatusPill tone={cronTone(item.status)} dot={item.status !== "error"}>
                      {item.status ?? "ok"}
                    </StatusPill>
                  </AdminTd>
                  <AdminTd align="right" numeric>
                    <TimeCell value={item.lastRunAt ?? null} />
                  </AdminTd>
                  <AdminTd align="right" numeric>
                    {fmtDuration(item.lastDurationMs) || ADMIN_DASH}
                  </AdminTd>
                  {/* Three labelled figures, the ones that are not zero first; the whole line
                      stays in the title so nothing a job wrote is lost. */}
                  <AdminTd truncate="max-w-[460px]">
                    {errored && item.lastError ? (
                      <span style={toneTextStyle("danger")} title={item.lastError}>
                        {item.lastError}
                      </span>
                    ) : figures.length ? (
                      <span className="inline-flex items-baseline gap-3" title={stats ?? undefined}>
                        {figures.slice(0, 3).map((f) => (
                          <span key={f.label} className="inline-flex items-baseline gap-1">
                            <span className="text-[var(--muted-2)]">{f.label}</span>
                            <span className="tabular-nums text-[var(--fg)]">{f.value}</span>
                          </span>
                        ))}
                        {figures.length > 3 ? (
                          <span className="text-[var(--muted-2)]">+{figures.length - 3} more</span>
                        ) : null}
                      </span>
                    ) : (
                      ADMIN_DASH
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
