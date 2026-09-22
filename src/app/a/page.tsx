/**
 * Admin home page: `/a`
 *
 * A dashboard, not a link farm. This page used to be a wall of tiles repeating the sidebar — every
 * destination already one click away on the left — which pushed the only real information below the
 * fold. It now opens with how the deployment is doing: headline figures, a chart of whichever one
 * you pick, then money, then the two things that need attention (failing jobs, pending deletions).
 *
 * Everything comes from two endpoints (`/api/admin/overview`, `/api/admin/revenue`) so the page
 * paints once instead of showing four spinners.
 */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import {
  AdminAlert,
  AdminPageHeader,
  AdminSection,
  AdminTrendChart,
  RevenueChart,
  StatusPill,
  type TrendMetric,
  type TrendPoint,
} from "@/components/admin";
import { ADMIN_PAGE_CONTAINER } from "@/lib/admin/layout";
import { ADMIN_FOCUS_RING, ADMIN_ROW_ACTION_LINK } from "@/lib/admin/ui";
import { fmtMoney, type RevenueDay } from "@/lib/admin/revenue";
import { fetchJson } from "@/lib/http/fetchJson";
import { cn } from "@/lib/cn";

type Overview = {
  days: number;
  totals: { users: number; orgs: number; docs: number; liveLinks: number; views: number; aiRuns: number; creditsCharged: number; newUsers: number; newDocs: number };
  trend: Record<"users" | "docs" | "views", { current: number; previous: number }>;
  health: { jobs: number; failing: string[]; pendingDeletions: number };
  series: TrendPoint[];
  /** One row per plan limit that refused somebody in the window; see the route for the two counts. */
  planLimits: Array<{ limit: string; hits: number; workspaces: number }>;
};

type Revenue = {
  subscriptions: { proActive: number; proEnding: number; payg: number; free: number };
  price: { proPriceLabel: string | null; proPriceCents: number | null };
  summary: { mrrCents: number | null; endingCents: number | null; packCents: number; onDemandCents: number; chargedCents: number; trendPct: number | null; packCount: number };
  series: RevenueDay[];
};

const RANGES = [7, 30, 90] as const;

/** A headline figure that also selects the chart's series. */
/**
 * What each limit key is called on screen.
 *
 * The stored value is the `LimitKey` the route refused with, which is fine in a row but reads as
 * an enum in a table somebody is using to decide where to set a price.
 */
const PLAN_LIMIT_LABELS: Record<string, string> = {
  documents: "Shared documents",
  projects: "Projects",
  collaborators: "Collaborators",
  team_workspaces: "Team workspaces",
  version_history: "Version history (Pro feature)",
  analytics_history: "Deep analytics (Pro feature)",
  project_links: "Extra project links (Pro feature)",
};

function MetricTile({
  label,
  value,
  hint,
  active,
  onClick,
}: {
  label: string;
  value: string;
  hint?: string;
  active?: boolean;
  onClick?: () => void;
}) {
  const body = (
    <>
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] leading-4 text-[var(--muted-2)]">{label}</div>
      <div className="mt-1 text-[24px] font-semibold leading-8 tabular-nums text-[var(--fg)]">{value}</div>
      {hint ? <div className="mt-0.5 text-[12px] leading-4 text-[var(--muted-2)]">{hint}</div> : null}
    </>
  );
  if (!onClick) {
    return <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">{body}</div>;
  }
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-xl border px-4 py-3 text-left transition-colors",
        active
          ? "border-[var(--fg)] bg-[var(--panel-hover)]"
          : "border-[var(--border)] bg-[var(--panel-2)] hover:bg-[var(--panel-hover)]",
        ADMIN_FOCUS_RING,
      )}
    >
      {body}
    </button>
  );
}

/** "+12% vs the 30 days before", or nothing when there is no previous window to compare to. */
function trendHint(current: number, previous: number, days: number): string {
  if (previous <= 0) return `in the last ${days} days`;
  const pct = Math.round(((current - previous) / previous) * 100);
  return `${pct >= 0 ? "+" : ""}${pct}% vs the ${days} before`;
}

export default function AdminHomePage() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [metric, setMetric] = useState<TrendMetric>("views");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [revenue, setRevenue] = useState<Revenue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [o, r] = await Promise.all([
          fetchJson<Overview>(`/api/admin/overview?days=${days}`),
          fetchJson<Revenue>(`/api/admin/revenue?days=${days}`),
        ]);
        if (cancelled) return;
        setOverview(o);
        setRevenue(r);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load the overview");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [days]);

  const t = overview?.totals;
  const planLimits = Array.isArray(overview?.planLimits) ? overview.planLimits : [];
  const num = (n: number | undefined) => (typeof n === "number" ? n.toLocaleString() : "—");

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className={ADMIN_PAGE_CONTAINER}>
        <AdminPageHeader
          title="Admin"
          description="How the deployment is doing. Every section of the admin area is in the sidebar."
          actions={
            <>
              {RANGES.map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={days === d}
                  onClick={() => setDays(d)}
                  className={cn(ADMIN_ROW_ACTION_LINK, days === d && "bg-[var(--panel-hover)] text-[var(--fg)]")}
                >
                  {d}d
                </button>
              ))}
            </>
          }
        />

        {error ? <AdminAlert className="mt-3">{error}</AdminAlert> : null}

        {/* The four tiles pick the chart's series: the number and its shape in one place. */}
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <MetricTile
            label="Views"
            value={num(t?.views)}
            hint={overview ? trendHint(overview.trend.views.current, overview.trend.views.previous, days) : "Recipient opens"}
            active={metric === "views"}
            onClick={() => setMetric("views")}
          />
          <MetricTile
            label="Documents"
            value={num(t?.newDocs)}
            hint={overview ? trendHint(overview.trend.docs.current, overview.trend.docs.previous, days) : "Created in the window"}
            active={metric === "docs"}
            onClick={() => setMetric("docs")}
          />
          <MetricTile
            label="Signups"
            value={num(t?.newUsers)}
            hint={overview ? trendHint(overview.trend.users.current, overview.trend.users.previous, days) : "New accounts"}
            active={metric === "users"}
            onClick={() => setMetric("users")}
          />
          <MetricTile
            label="AI runs"
            value={num(t?.aiRuns)}
            hint={t ? `${num(t.creditsCharged)} credits charged` : "Summaries and compares"}
            active={metric === "aiRuns"}
            onClick={() => setMetric("aiRuns")}
          />
        </div>

        <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3">
          {loading && !overview ? (
            <div className="flex h-[220px] items-center justify-center text-[12px] text-[var(--muted-2)]">Loading…</div>
          ) : (
            <AdminTrendChart series={overview?.series ?? []} metric={metric} />
          )}
        </div>

        {/* What is standing right now, rather than what happened in the window. */}
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <MetricTile label="Workspaces" value={num(t?.orgs)} hint={revenue ? `${revenue.subscriptions.proActive} on Pro` : undefined} />
          <MetricTile label="Accounts" value={num(t?.users)} hint="Active, not deleted" />
          <MetricTile label="Documents" value={num(t?.docs)} hint="Live, not archived" />
          <MetricTile label="Share links" value={num(t?.liveLinks)} hint="Enabled and not archived" />
        </div>

        <AdminSection
          title="Where the plan stops people"
          description="Every refusal a plan limit produced in the window. Eight routes have been recording these since limits shipped; this is the first screen to read them."
        >
          {planLimits.length ? (
            <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)]">
              <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 border-b border-[var(--border)] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-2)]">
                <span>Limit</span>
                <span className="text-right">Refusals</span>
                <span className="text-right">Workspaces</span>
              </div>
              <ul className="divide-y divide-[var(--border)]">
                {planLimits.map((row) => (
                  <li
                    key={row.limit}
                    className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 px-4 py-2.5 text-[13px] text-[var(--fg)]"
                  >
                    <span className="truncate font-medium">{PLAN_LIMIT_LABELS[row.limit] ?? row.limit}</span>
                    <span className="text-right tabular-nums">{num(row.hits)}</span>
                    {/* The second number is the one that matters for pricing: one workspace
                        retrying twenty times is demand in the first column and a single frustrated
                        person in this one. */}
                    <span className="text-right tabular-nums text-[var(--muted)]">{num(row.workspaces)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-6 text-center text-[13px] text-[var(--muted)]">
              No plan limit was reached in this window.
            </p>
          )}
        </AdminSection>

        <AdminSection
          title="Revenue"
          description="Run-rate from subscriptions, and what credit packs and on-demand usage charged in the window."
        >
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <MetricTile
              label="Monthly run-rate"
              value={fmtMoney(revenue?.summary.mrrCents ?? null)}
              hint={
                revenue?.price.proPriceCents == null
                  ? "Pro price unknown: set it from Tools › Billing"
                  : `${revenue.subscriptions.proActive} Pro × ${revenue.price.proPriceLabel ?? fmtMoney(revenue.price.proPriceCents)}`
              }
            />
            <MetricTile
              label="Ending"
              value={fmtMoney(revenue?.summary.endingCents ?? null)}
              hint={revenue?.subscriptions.proEnding ? `${revenue.subscriptions.proEnding} cancelled, still paid` : "No cancellations pending"}
            />
            <MetricTile
              label={`Charged, ${days}d`}
              value={fmtMoney(revenue?.summary.chargedCents ?? null)}
              hint={
                revenue?.summary.trendPct == null
                  ? "Credit packs + on-demand"
                  : `${revenue.summary.trendPct >= 0 ? "+" : ""}${revenue.summary.trendPct}% vs the ${days} before`
              }
            />
            <MetricTile
              label="Credit packs"
              value={String(revenue?.summary.packCount ?? 0)}
              hint={`${fmtMoney(revenue?.summary.packCents ?? 0)} of ${fmtMoney(revenue?.summary.chargedCents ?? 0)}`}
            />
          </div>
          <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3">
            <RevenueChart series={revenue?.series ?? []} />
            <p className="mt-2 text-[11px] leading-4 text-[var(--muted-2)]">
              Packs are charges Stripe confirmed; on-demand is metered usage priced at 10¢ a credit and reported to Stripe by a
              job. Stripe invoices are not stored here, so none of this is money received.
            </p>
          </div>
        </AdminSection>

        <AdminSection title="Needs attention" description="The two questions this page gets opened for.">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-[13px] font-semibold text-[var(--fg)]">Background jobs</div>
                <Link href="/a/cron-health" className={ADMIN_ROW_ACTION_LINK}>
                  Open the board
                </Link>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-[var(--muted-2)]">
                {overview?.health.failing.length ? (
                  <>
                    <StatusPill tone="danger">{overview.health.failing.length} failing</StatusPill>
                    <span>{overview.health.failing.join(", ")}</span>
                  </>
                ) : (
                  <>
                    <StatusPill tone="quiet">All ok</StatusPill>
                    <span>{overview?.health.jobs ?? 0} jobs reporting</span>
                  </>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-[13px] font-semibold text-[var(--fg)]">Account deletions</div>
                <Link href="/a/deletions" className={ADMIN_ROW_ACTION_LINK}>
                  See who left
                </Link>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-[var(--muted-2)]">
                {overview?.health.pendingDeletions ? (
                  <>
                    <StatusPill tone="warning">{overview.health.pendingDeletions} waiting</StatusPill>
                    <span>Inside the 30-day window, data not yet removed</span>
                  </>
                ) : (
                  <>
                    <StatusPill tone="quiet">None</StatusPill>
                    <span>No account is waiting to be purged</span>
                  </>
                )}
              </div>
            </div>
          </div>
        </AdminSection>
      </div>
    </div>
  );
}
