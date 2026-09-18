/**
 * Admin home page: `/a`
 *
 * The map of the admin area. The tiles are the sidebar's own sections, in the sidebar's order,
 * and each one says what is behind it rather than repeating its name — a tile that only links
 * is worth less than the sidebar entry beside it. Below them, the cron summary, because "did the
 * jobs run" is the question this page gets opened for.
 *
 * Two things this page used to get wrong: the tiles sat in a three-column grid, so a section with
 * one destination read as a row with two tiles missing; and the whole of `/a/cron-health` was
 * re-rendered underneath, second page header and all. The tiles now flow at a fixed width, and
 * the cron block is three figures that link to the board.
 */
"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import Button from "@/components/ui/Button";
import { AdminAlert, AdminPageHeader, AdminSection, RevenueChart, StatTile } from "@/components/admin";
import { type CronHealthItem } from "@/lib/admin/cronHealth";
import { ADMIN_PAGE_CONTAINER } from "@/lib/admin/layout";
import { ADMIN_DASH, ADMIN_ROW_ACTION_LINK, ADMIN_TILE, fmtAdminDateTime } from "@/lib/admin/ui";
import { fmtMoney, type RevenueDay } from "@/lib/admin/revenue";
import { fetchJson } from "@/lib/http/fetchJson";

type Tile = {
  href: string;
  label: string;
  /** What is behind the link. One line, lowercase prose, no "view the …". */
  blurb: string;
};

type TileSection = { label: string; tiles: Tile[] };

/**
 * The sidebar's sections, with a sentence each. Kept in the sidebar's order so the two read as
 * one map of the same place; a route added to the sidebar belongs here too.
 */
const SECTIONS: TileSection[] = [
  {
    label: "Metrics",
    tiles: [
      {
        href: "/a/shareviews",
        label: "Share views",
        blurb: "Who opened a share, how far they read, and what they downloaded.",
      },
    ],
  },
  {
    label: "AI",
    tiles: [
      {
        href: "/a/ai-runs",
        label: "Runs",
        blurb: "Every prompt the product sent a model, with the output it got back.",
      },
    ],
  },
  {
    label: "Billing",
    tiles: [
      {
        href: "/a/credits",
        label: "Credits",
        blurb: "Balances, ledger and on-demand spend, with anomalies called out first.",
      },
    ],
  },
  {
    label: "Data",
    tiles: [
      { href: "/a/data/workspaces", label: "Workspaces", blurb: "Every workspace, its plan and its members." },
      { href: "/a/data/users", label: "Users", blurb: "Every account. Override a plan or deactivate one in place." },
      { href: "/a/data/docs", label: "Docs", blurb: "Every document across all users, newest first." },
      { href: "/a/data/links", label: "Links", blurb: "Every share link, its state and the traffic it has drawn." },
      { href: "/a/data/projects", label: "Projects", blurb: "Project pages and the links that point at them." },
      { href: "/a/data/requests", label: "Requests", blurb: "Download requests and how their owners answered." },
      { href: "/a/data/uploads", label: "Uploads", blurb: "Files that reached storage, and what became of them." },
    ],
  },
  {
    label: "System",
    tiles: [
      { href: "/a/cron-health", label: "Cron health", blurb: "The last heartbeat from every background job." },
      { href: "/a/emails", label: "Emails", blurb: "Every email the product can send, and what proof a send leaves." },
    ],
  },
  {
    label: "Tools",
    tiles: [
      { href: "/a/tools/cache", label: "Cache", blurb: "Inspect and clear this browser's local caches." },
      { href: "/a/tools/billing", label: "Billing", blurb: "Refresh the Pro price label from Stripe." },
    ],
  },
];

/**
 * One destination: its name, and a line saying what is behind it.
 *
 * Fixed width rather than a grid track: a section with a single destination is then one card,
 * not one card and two empty columns. Every card is the same two lines — a status line on one
 * of them and not the rest made the card anatomy unreadable.
 */
function SectionTile({ tile }: { tile: Tile }) {
  return (
    <Link href={tile.href} className={`${ADMIN_TILE} w-full sm:w-[calc(50%-0.25rem)] xl:w-[302px]`}>
      <div className="text-[13px] font-semibold leading-5 text-[var(--fg)]">{tile.label}</div>
      <div className="mt-0.5 text-[12px] leading-5 text-[var(--muted-2)]">{tile.blurb}</div>
    </Link>
  );
}

/** The admin landing page: the area's sections, then the cron board. */
type RevenueResponse = {
  days: number;
  subscriptions: { proActive: number; proEnding: number; payg: number; otherBillable: number; free: number };
  price: { proPriceLabel: string | null; proPriceCents: number | null };
  summary: {
    mrrCents: number | null;
    endingCents: number | null;
    packCents: number;
    onDemandCents: number;
    chargedCents: number;
    trendPct: number | null;
    packCount: number;
  };
  series: RevenueDay[];
};

/** The window switcher beside the Revenue title: the same 26px control as a row action. */
const ADMIN_RANGE_IDLE = ADMIN_ROW_ACTION_LINK;
const ADMIN_RANGE_ACTIVE = ADMIN_ROW_ACTION_LINK + " bg-[var(--panel-hover)] text-[var(--fg)]";

export default function AdminHomePage() {
  const [health, setHealth] = useState<CronHealthItem[]>([]);
  const [healthLoading, setHealthLoading] = useState(false);
  // Revenue: run-rate from subscriptions plus what packs and on-demand actually charged.
  const [revenueDays, setRevenueDays] = useState<7 | 30 | 90>(30);
  const [revenue, setRevenue] = useState<RevenueResponse | null>(null);
  const [revenueError, setRevenueError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const json = (await fetchJson(`/api/admin/revenue?days=${revenueDays}`)) as RevenueResponse;
        if (!cancelled) {
          setRevenue(json);
          setRevenueError(null);
        }
      } catch (e) {
        if (!cancelled) setRevenueError(e instanceof Error ? e.message : "Failed to load revenue");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [revenueDays]);

  const [healthError, setHealthError] = useState<string | null>(null);

  const normalized = useMemo(() => (Array.isArray(health) ? health : []), [health]);
  const failing = useMemo(() => normalized.filter((i) => i.status === "error"), [normalized]);

  /** Read the current cron snapshots. */
  async function load() {
    setHealthLoading(true);
    setHealthError(null);
    try {
      const data = await fetchJson<{ items?: unknown }>("/api/admin/cron-health?limit=20", { method: "GET" });
      setHealth(Array.isArray(data.items) ? (data.items as CronHealthItem[]) : []);
    } catch (e) {
      setHealthError(e instanceof Error ? e.message : "Failed to load cron health");
      setHealth([]);
    } finally {
      setHealthLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  /** The oldest heartbeat on the board: the one that says a job has stopped reporting. */
  const oldestHeartbeat = useMemo(() => {
    let oldest: number | null = null;
    for (const item of normalized) {
      const t = item.lastRunAt ? new Date(item.lastRunAt).valueOf() : NaN;
      if (!Number.isFinite(t)) continue;
      if (oldest === null || t < oldest) oldest = t;
    }
    return oldest;
  }, [normalized]);

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className={ADMIN_PAGE_CONTAINER}>
        <AdminPageHeader
          title="Admin"
          description="Every part of the admin area, and the background jobs that keep it fed."
        />

        {/* The section name sits in a gutter beside its destinations, so a section with one
            destination reads as one card next to its label rather than a row missing two. */}
        <div className="mt-6 grid gap-4">
          {SECTIONS.map((section) => (
            <section key={section.label} className="grid gap-2 sm:grid-cols-[92px_minmax(0,1fr)] sm:items-start">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.06em] leading-4 text-[var(--muted-2)] sm:pt-3">
                {section.label}
              </h2>
              <div className="flex flex-wrap gap-2">
                {section.tiles.map((tile) => (
                  <SectionTile key={tile.href} tile={tile} />
                ))}
              </div>
            </section>
          ))}
        </div>

        <AdminSection
          title="Revenue"
          description="Run-rate from subscriptions, and what credit packs and on-demand usage charged in the window."
          actions={
            <>
              {([7, 30, 90] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  className={revenueDays === d ? ADMIN_RANGE_ACTIVE : ADMIN_RANGE_IDLE}
                  aria-pressed={revenueDays === d}
                  onClick={() => setRevenueDays(d)}
                >
                  {d}d
                </button>
              ))}
            </>
          }
        >
          {revenueError ? <AdminAlert>{revenueError}</AdminAlert> : null}

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Monthly run-rate"
              value={fmtMoney(revenue?.summary.mrrCents ?? null)}
              hint={
                revenue?.price.proPriceCents == null
                  ? "Pro price unknown: set it from Tools › Billing"
                  : `${revenue.subscriptions.proActive} Pro × ${revenue.price.proPriceLabel ?? fmtMoney(revenue.price.proPriceCents)}`
              }
            />
            <StatTile
              label="Ending"
              value={fmtMoney(revenue?.summary.endingCents ?? null)}
              hint={
                revenue?.subscriptions.proEnding
                  ? `${revenue.subscriptions.proEnding} cancelled, still inside the paid period`
                  : "No cancellations pending"
              }
            />
            <StatTile
              label={`Charged, ${revenueDays}d`}
              value={fmtMoney(revenue?.summary.chargedCents ?? null)}
              hint={
                revenue?.summary.trendPct == null
                  ? "Credit packs + on-demand usage"
                  : `${revenue.summary.trendPct >= 0 ? "+" : ""}${revenue.summary.trendPct}% vs the ${revenueDays} days before`
              }
            />
            <StatTile
              label="Workspaces"
              value={revenue ? String(revenue.subscriptions.proActive + revenue.subscriptions.payg + revenue.subscriptions.free) : "—"}
              hint={
                revenue
                  ? `${revenue.subscriptions.proActive} Pro · ${revenue.subscriptions.payg} pay-as-you-go · ${revenue.subscriptions.free} free`
                  : "Loading…"
              }
            />
          </div>

          <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3">
            <RevenueChart series={revenue?.series ?? []} />
            <p className="mt-2 text-[11px] leading-4 text-[var(--muted-2)]">
              Credit packs are charges Stripe confirmed ({revenue?.summary.packCount ?? 0} in this window,{" "}
              {fmtMoney(revenue?.summary.packCents ?? 0)}). On-demand ({fmtMoney(revenue?.summary.onDemandCents ?? 0)}) is metered
              usage priced at 10¢ a credit and reported to Stripe by a job, so it is what will be invoiced, not an invoice. Stripe
              invoices are not stored here, so none of this is money received.
            </p>
          </div>
        </AdminSection>

        {/* A summary, not a second copy of the board: the page it belongs to is one click away,
            and re-rendering it here gave the page a second header and a second Refresh. */}
        <AdminSection
          title="Cron health"
          description="The last heartbeat from every background job. One snapshot per job, overwritten each tick."
          actions={
            <>
              <Button variant="outline" onClick={() => void load()} disabled={healthLoading}>
                {healthLoading ? "Loading…" : "Refresh"}
              </Button>
              <Link href="/a/cron-health" className={ADMIN_ROW_ACTION_LINK}>
                Open the board
              </Link>
            </>
          }
        >
          {healthError ? <AdminAlert>{healthError}</AdminAlert> : null}

          <div className="grid gap-2 sm:grid-cols-3">
            <StatTile label="Jobs reporting" value={normalized.length.toLocaleString()} hint="Snapshots on the board" />
            <StatTile
              label="Failing"
              value={failing.length.toLocaleString()}
              hint={failing.length ? failing.map((f) => f.jobKey).join(", ") : "Every job wrote an ok"}
              tone={failing.length ? "danger" : undefined}
            />
            <StatTile
              label="Oldest heartbeat"
              value={oldestHeartbeat ? fmtAdminDateTime(oldestHeartbeat) : ADMIN_DASH}
              hint="The job that reported least recently"
            />
          </div>
        </AdminSection>
      </div>
    </div>
  );
}
