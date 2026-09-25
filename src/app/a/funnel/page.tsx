/**
 * Admin route: `/a/funnel`
 *
 * The upgrade funnel, one row per ISO week: workspaces that signed up, hit their first wall, saw
 * the upgrade prompt, pressed something on it, saw the Free analytics teaser, started a Checkout
 * (Pro or a credit pack) and were upgraded. Above the table: the median days from sign-up to the
 * first wall and which limit is the first wall, the two numbers Phase 5 of the pricing plan says
 * to decide on. Every figure counts workspaces, not events.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import Button from "@/components/ui/Button";
import {
  AdminAccessState,
  AdminAlert,
  AdminFilterBar,
  AdminPageHeader,
  AdminTable,
  AdminTableMessage,
  AdminTd,
  AdminTh,
  AdminTr,
  StatTile,
  useAdminAccess,
} from "@/components/admin";
import { ADMIN_PAGE_CONTAINER } from "@/lib/admin/layout";
import { ADMIN_DASH, fmtAdminDate } from "@/lib/admin/ui";
import type { FunnelReport, FunnelWeek } from "@/lib/funnel/report";
import { fetchJson } from "@/lib/http/fetchJson";

const COLUMN_COUNT = 13;
const WEEK_OPTIONS = [8, 12, 26] as const;

/** What each limit key is called on screen; the stored value is the `LimitKey` a route refused with. */
const LIMIT_LABELS: Record<string, string> = {
  documents: "Shared documents",
  projects: "Projects",
  collaborators: "Collaborators",
  team_workspaces: "Workspaces",
  version_history: "Version history",
  analytics_history: "Deep analytics",
  project_links: "Project links",
};

const DESCRIPTION = "Workspaces at each step of the upgrade funnel, per week. One person retrying a wall twenty times is one workspace here.";

function n(v: number): string {
  return v === 0 ? ADMIN_DASH : v.toLocaleString();
}

/** Sum a per-week figure over the report. */
function total(weeks: FunnelWeek[], pick: (w: FunnelWeek) => number): number {
  return weeks.reduce((acc, w) => acc + pick(w), 0);
}

/** The funnel page. */
export default function FunnelAdminPage() {
  const access = useAdminAccess();
  const canUseAdmin = access.canUseAdmin;

  const [weeks, setWeeks] = useState<number>(8);
  const [report, setReport] = useState<FunnelReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Read the report for the chosen window. */
  async function load(count: number) {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson<FunnelReport>(`/api/admin/funnel?weeks=${count}`, { method: "GET" });
      setReport(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the funnel");
      setReport(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!canUseAdmin) return;
    void load(weeks);
  }, [canUseAdmin, weeks]);

  // Newest week first: the question is "what happened this week", and the older rows are context.
  const rows = useMemo(() => (report ? [...report.weeks].reverse() : []), [report]);
  const totals = useMemo(() => {
    const ws = report?.weeks ?? [];
    return {
      signups: total(ws, (w) => w.signups),
      firstWalls: total(ws, (w) => w.firstWalls),
      modalShown: total(ws, (w) => w.modalShown),
      upgrade: total(ws, (w) => w.ctaClicked.upgrade),
      checkoutPro: total(ws, (w) => w.checkoutPro),
      checkoutPack: total(ws, (w) => w.checkoutPack),
      upgraded: total(ws, (w) => w.upgraded),
    };
  }, [report]);
  const firstLimit = report?.firstWall.byLimit[0] ?? null;

  if (!canUseAdmin) {
    return <AdminAccessState access={access} title="Funnel" description={DESCRIPTION} callbackUrl="/a/funnel" />;
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className={ADMIN_PAGE_CONTAINER}>
        <AdminPageHeader title="Funnel" description={DESCRIPTION} />

        <AdminFilterBar
          className="mt-4"
          page={1}
          pageSize={Math.max(1, rows.length)}
          total={rows.length}
          noun="weeks"
          loading={loading}
          actions={
            <>
              <div className="flex items-center gap-1" role="group" aria-label="Window">
                {WEEK_OPTIONS.map((w) => (
                  <Button key={w} variant={w === weeks ? "solid" : "outline"} size="sm" onClick={() => setWeeks(w)} disabled={loading}>
                    {w} weeks
                  </Button>
                ))}
              </div>
              <Button variant="outline" onClick={() => void load(weeks)} disabled={loading}>
                {loading ? "Loading…" : "Refresh"}
              </Button>
            </>
          }
        />

        {error ? <AdminAlert className="mt-3">{error}</AdminAlert> : null}

        {/* The two decisions the pricing plan waits on (Phase 5): how long a workspace lasts
            before it meets a wall, and which wall it meets. Then the window's totals, so the table
            below reads as detail rather than as the only summary. */}
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Days to first wall (median)"
            value={report?.firstWall.medianDays === null || report?.firstWall.medianDays === undefined ? ADMIN_DASH : String(report.firstWall.medianDays)}
            hint={report ? `${report.firstWall.workspaces.toLocaleString()} first walls in the window` : undefined}
          />
          <StatTile
            label="Most common first wall"
            value={firstLimit ? (LIMIT_LABELS[firstLimit.limit] ?? firstLimit.limit) : ADMIN_DASH}
            hint={firstLimit ? `${firstLimit.workspaces.toLocaleString()} workspaces` : undefined}
          />
          <StatTile label="Sign-ups" value={n(totals.signups)} hint="workspaces created in the window" />
          <StatTile
            label="Upgraded"
            value={n(totals.upgraded)}
            hint={`${n(totals.checkoutPro)} Pro and ${n(totals.checkoutPack)} pack checkouts started`}
          />
        </div>

        {report && report.firstWall.byLimit.length > 1 ? (
          <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3 text-[12px] leading-5 text-[var(--muted-2)]">
            <span className="font-semibold text-[var(--fg)]">First walls by limit:</span>{" "}
            {report.firstWall.byLimit.map((r, i) => (
              <span key={r.limit}>
                {i > 0 ? " · " : ""}
                {LIMIT_LABELS[r.limit] ?? r.limit} {r.workspaces.toLocaleString()}
              </span>
            ))}
          </div>
        ) : null}

        <AdminTable
          className="mt-3"
          ariaLabel="Funnel by week"
          head={
            <>
              <AdminTh>Week</AdminTh>
              <AdminTh align="right">Sign-ups</AdminTh>
              <AdminTh align="right">First wall</AdminTh>
              <AdminTh align="right">Any wall</AdminTh>
              <AdminTh align="right">Prompt shown</AdminTh>
              <AdminTh align="right">Upgrade</AdminTh>
              <AdminTh align="right">Pack</AdminTh>
              <AdminTh align="right">Compare</AdminTh>
              <AdminTh align="right">Dismissed</AdminTh>
              <AdminTh align="right">Teaser shown</AdminTh>
              <AdminTh align="right">Checkout Pro</AdminTh>
              <AdminTh align="right">Checkout pack</AdminTh>
              <AdminTh align="right">Upgraded</AdminTh>
            </>
          }
        >
          {loading && rows.length === 0 ? (
            <AdminTableMessage colSpan={COLUMN_COUNT}>Loading the funnel…</AdminTableMessage>
          ) : rows.length === 0 ? (
            <AdminTableMessage colSpan={COLUMN_COUNT}>No weeks to show.</AdminTableMessage>
          ) : (
            rows.map((w) => (
              <AdminTr key={w.week}>
                <AdminTd primary>
                  <span title={`ISO week starting ${w.week} (UTC)`}>{fmtAdminDate(w.week)}</span>
                </AdminTd>
                <AdminTd align="right" numeric>{n(w.signups)}</AdminTd>
                <AdminTd align="right" numeric>{n(w.firstWalls)}</AdminTd>
                <AdminTd align="right" numeric>{n(w.walls)}</AdminTd>
                <AdminTd align="right" numeric>{n(w.modalShown)}</AdminTd>
                <AdminTd align="right" numeric>{n(w.ctaClicked.upgrade)}</AdminTd>
                <AdminTd align="right" numeric>{n(w.ctaClicked.pack)}</AdminTd>
                <AdminTd align="right" numeric>{n(w.ctaClicked.compare)}</AdminTd>
                <AdminTd align="right" numeric>{n(w.ctaClicked.dismiss)}</AdminTd>
                <AdminTd align="right" numeric>
                  {n(w.teaserShown)}
                  {w.teaserMedianViewers !== null ? (
                    <span className="ml-1 text-[11px] text-[var(--muted-2)]" title="Median readers counted at the moment the teaser was shown">
                      ({w.teaserMedianViewers.toLocaleString()} readers)
                    </span>
                  ) : null}
                </AdminTd>
                <AdminTd align="right" numeric>{n(w.checkoutPro)}</AdminTd>
                <AdminTd align="right" numeric>{n(w.checkoutPack)}</AdminTd>
                <AdminTd align="right" numeric>{n(w.upgraded)}</AdminTd>
              </AdminTr>
            ))
          )}
        </AdminTable>

        <p className="mt-3 text-[12px] leading-5 text-[var(--muted-2)]">
          Weeks are ISO weeks in UTC, newest first. First wall is the week a workspace hit its first ever plan limit;
          any wall counts a workspace once per week whatever it hit. The prompt is the upgrade or out-of-credits modal;
          the teaser is the Free analytics block, with the median number of readers it was showing. Checkouts are Stripe
          sessions started; upgraded is the webhook moving the workspace to Pro.
        </p>
      </div>
    </div>
  );
}
