/**
 * Page for `/dashboard` — standalone dashboard hub (overview/account/workspace/teams/usage/limits/billing).
 */
"use client";

import SubscriptionCard from "./SubscriptionCard";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ORGS_CACHE_UPDATED_EVENT, readOrgsCacheSnapshot, refreshOrgsCache } from "@/lib/orgsCache";
import Modal from "@/components/modals/Modal";
import Alert from "@/components/ui/Alert";
import IconButton from "@/components/ui/IconButton";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { cn } from "@/lib/cn";
import {
  BanknotesIcon,
  ChartBarIcon,
  ChartPieIcon,
  Cog6ToothIcon,
  CreditCardIcon,
  PencilSquareIcon,
  UserCircleIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";

// Perf: keep the dashboard Overview bundle lean.
// Tabs and charts are split into separate chunks and loaded only when needed.
const WorkspaceManager = dynamic(() => import("./WorkspaceManager"));
const TeamsManager = dynamic(() => import("./TeamsManager"));
const UsageTable = dynamic(() => import("./UsageTable"));
const CreditsSummaryCard = dynamic(() => import("./CreditsSummaryCard"));
const SpendLimitModule = dynamic(() => import("./SpendLimitModule"));
const OnDemandUsageCard = dynamic(() => import("./OnDemandUsageCard"));
const AiQualityDefaultsCard = dynamic(() => import("./AiQualityDefaultsCard"));
const BillingInvoicesTab = dynamic(() => import("./BillingInvoicesTab"));
const DailyUsageChart = dynamic(() => import("./DailyUsageChart"));
const NotificationPreferences = dynamic(() => import("@/components/notifications/NotificationPreferences"));
const MultiLineChart30d = dynamic(() => import("./MultiLineChart30d"), {
  loading: () => <div className="h-[224px] w-full animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />,
});

function Section({
  title,
  description,
  helper,
  children,
}: {
  title: string;
  description: string;
  helper?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="text-[24px] font-semibold tracking-tight text-[var(--fg)]">{title}</div>
      <div className="mt-1.5 text-[13px] text-[var(--muted-2)]">{description}</div>
      {helper ? (
        <div className="mt-2 text-[12px] font-medium leading-5 text-[var(--muted)]">{helper}</div>
      ) : null}
      <div className="mt-7">{children}</div>
    </section>
  );
}

type DashTab = "overview" | "account" | "workspace" | "teams" | "usage" | "limits" | "billing";
type DashTabParam = DashTab | "spending";

const TAB_GROUPS: Array<{ items: Array<{ id: DashTab; label: string }> }> = [
  {
    items: [
      { id: "overview", label: "Overview" },
      { id: "account", label: "Account" },
    ],
  },
  {
    items: [
      { id: "workspace", label: "Workspace" },
      { id: "teams", label: "Teams" },
    ],
  },
  {
    items: [
      { id: "usage", label: "Usage" },
      { id: "limits", label: "Limits" },
      { id: "billing", label: "Billing & Invoices" },
    ],
  },
];

const TAB_ICON: Record<DashTab, React.ReactNode> = {
  overview: <ChartPieIcon className="h-4 w-4" />,
  account: <UserCircleIcon className="h-4 w-4" />,
  workspace: <Cog6ToothIcon className="h-4 w-4" />,
  teams: <UsersIcon className="h-4 w-4" />,
  usage: <ChartBarIcon className="h-4 w-4" />,
  limits: <BanknotesIcon className="h-4 w-4" />,
  billing: <CreditCardIcon className="h-4 w-4" />,
};

function isDashTab(v: unknown): v is DashTabParam {
  return (
    v === "overview" ||
    v === "account" ||
    v === "workspace" ||
    v === "teams" ||
    v === "usage" ||
    v === "limits" ||
    v === "spending" ||
    v === "billing"
  );
}

function tabFromSearchParams(searchParams: URLSearchParams | null): DashTab {
  const raw = searchParams?.get("tab") ?? "";
  if (!isDashTab(raw)) return "overview";
  return raw === "spending" ? "limits" : raw;
}

// Small in-memory cache to avoid visible "loading" states on initial render and when
// navigating between dashboard tabs (tab switches are client-side and can re-run effects).
const DASHBOARD_STATS_CACHE_TTL_MS = 30_000;
let dashboardStatsCache: { data: any; at: number } | null = null;

const DASHBOARD_NAV_OPEN_EVENT = "lnkdrp:dashboard-nav-open";

function PlaceholderTile({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl bg-[var(--panel-2)] p-4">
      <div className="text-[13px] font-semibold text-[var(--fg)]">{title}</div>
      <div className="mt-1 text-[12px] text-[var(--muted-2)]">{body}</div>
      <div className="mt-3 h-10 rounded-lg bg-[var(--panel-hover)]" aria-hidden="true" />
    </div>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlTab = useMemo(() => tabFromSearchParams(searchParams), [searchParams]);
  // Optimistic tab state so UI switches immediately on click; URL sync follows.
  const [tab, setTab] = useState<DashTab>(urlTab);
  const { data: session, update: updateSession } = useSession();
  const [limitsAttention, setLimitsAttention] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const name = (session?.user?.name ?? "").trim() || "Account";
  const email = (session?.user?.email ?? "").trim();
  const [activeWorkspaceName, setActiveWorkspaceName] = useState<string>("");
  const [editNameOpen, setEditNameOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [firstName, setFirstName] = useState<string>(() => name.split(" ")[0] ?? "");
  const [lastName, setLastName] = useState<string>(() => {
    const parts = name.split(" ").filter(Boolean);
    return parts.length > 1 ? parts.slice(1).join(" ") : "";
  });

  type DashboardStats = {
    ok: true;
    docs: { active: number; created30d: number };
    projects: { active: number; requests: number };
    uploads: { created30d: number };
    sharing: { viewsTotal: number; pagesViewedTotal: number; views30d: number; pagesViewed30d: number };
    series30d: Array<{
      day: string; // YYYY-MM-DD (UTC)
      docsCreated: number;
      uploadsCreated: number;
      shareUniqueViews: number;
      shareDownloads: number;
    }>;
  };
  const [stats, setStats] = useState<DashboardStats | null>(() => (dashboardStatsCache?.data as DashboardStats | null) ?? null);
  const [statsBusy, setStatsBusy] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [usageDays, setUsageDays] = useState<1 | 7 | 30>(30);

  const userKey = useMemo(() => (session?.user?.email ?? "").trim(), [session?.user?.email]);

  useEffect(() => {
    setTab(urlTab);
  }, [urlTab]);

  useEffect(() => {
    const onOpen = () => setMobileNavOpen(true);
    window.addEventListener(DASHBOARD_NAV_OPEN_EVENT, onOpen as any);
    return () => window.removeEventListener(DASHBOARD_NAV_OPEN_EVENT, onOpen as any);
  }, []);

  useEffect(() => {
    const onBanner = (e: Event) => {
      const ev = e as CustomEvent<{ blocked: boolean; dismissed: boolean }>;
      const blocked = Boolean(ev?.detail?.blocked);
      const dismissed = Boolean(ev?.detail?.dismissed);
      setLimitsAttention(blocked && dismissed);
    };
    window.addEventListener("lnkdrp:credits-blocked-banner", onBanner as any);
    return () => window.removeEventListener("lnkdrp:credits-blocked-banner", onBanner as any);
  }, []);

  useEffect(() => {
    if (!userKey) return;
    let cancelled = false;

    const hydrate = () => {
      const snap = readOrgsCacheSnapshot(userKey);
      if (!snap) return;
      const activeId = typeof snap.activeOrgId === "string" ? snap.activeOrgId : "";
      const org = snap.orgs?.find?.((o) => o.id === activeId);
      const label = (org?.name ?? "").trim();
      if (!cancelled) setActiveWorkspaceName(label);
    };

    hydrate();

    // Best-effort refresh to ensure the banner reflects server state (cache is not a source of truth).
    void (async () => {
      try {
        await refreshOrgsCache({ userKey, force: false });
        hydrate();
      } catch {
        // ignore
      }
    })();

    window.addEventListener(ORGS_CACHE_UPDATED_EVENT, hydrate);
    return () => {
      cancelled = true;
      window.removeEventListener(ORGS_CACHE_UPDATED_EVENT, hydrate);
    };
  }, [userKey]);

  useEffect(() => {
    // Keep modal inputs in sync with the latest session name.
    const trimmed = (session?.user?.name ?? "").trim();
    if (!trimmed) return;
    const parts = trimmed.split(" ").filter(Boolean);
    setFirstName(parts[0] ?? "");
    setLastName(parts.length > 1 ? parts.slice(1).join(" ") : "");
  }, [session?.user?.name]);

  useEffect(() => {
    if (tab !== "overview") return;
    let cancelled = false;
    const cachedAt = dashboardStatsCache?.at ?? 0;
    const cachedFresh = Boolean(dashboardStatsCache?.data) && Date.now() - cachedAt < DASHBOARD_STATS_CACHE_TTL_MS;
    // If cached data exists, render immediately and avoid flipping into a "Loading…" state.
    setStatsBusy(!cachedFresh && !stats);
    setStatsError(null);
    void (async () => {
      try {
        if (cachedFresh && dashboardStatsCache?.data) {
          // Avoid refetching within the cache window (reduces concurrent startup load).
          if (!cancelled) setStats(dashboardStatsCache.data as DashboardStats);
          return;
        }
        const res = await fetch("/api/dashboard/stats", { method: "GET" });
        const data = (await res.json().catch(() => null)) as DashboardStats | { error?: string } | null;
        if (!res.ok) throw new Error((data as any)?.error || `Request failed (${res.status})`);
        if (!data || (data as any).ok !== true) throw new Error("Invalid response");
        if (!cancelled) setStats(data as DashboardStats);
        dashboardStatsCache = { data: data as DashboardStats, at: Date.now() };
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to load stats";
        // If we already have cached stats, keep them and avoid surfacing a transient error.
        if (!cancelled && !dashboardStatsCache?.data) setStatsError(msg);
      } finally {
        if (!cancelled) setStatsBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab]);

  // NOTE: `/api/billing/spend` is fetched by the Limits tab components (`SpendLimitModule` / `OnDemandUsageCard`).

  function navigateToTab(nextTab: DashTab) {
    setTab(nextTab);
    const href = `/dashboard?tab=${encodeURIComponent(nextTab)}`;
    router.push(href, { scroll: false });
  }

  function DashboardMenu({ onNavigate }: { onNavigate?: () => void }) {
    return (
      <div className="p-2">
        <div className="px-1 pb-4 pt-1">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 truncate text-[14px] font-semibold text-[var(--fg)]">{name}</div>
            <IconButton
              ariaLabel="Edit your name"
              title="Edit name"
              size="sm"
              className="shrink-0"
              onClick={() => {
                setNameError(null);
                setEditNameOpen(true);
                onNavigate?.();
              }}
            >
              <PencilSquareIcon className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          </div>
          {email ? <div className="mt-0.5 truncate text-[12px] text-[var(--muted-2)]">{email}</div> : null}
          {activeWorkspaceName ? (
            <div className="mt-0.5 truncate text-[12px] text-[var(--muted-2)]">{activeWorkspaceName}</div>
          ) : null}
        </div>
        <div className="my-3 h-px bg-[var(--border)]" />
        <nav className="grid gap-2">
          {TAB_GROUPS.map((g, groupIdx) => (
            <div key={groupIdx}>
              <div className="grid">
                {g.items.map((t) => {
                  const active = t.id === tab;
                  const showLimitsAttention = t.id === "limits" && !active && limitsAttention;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      className={cn(
                        "flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-[13px] font-semibold",
                        active
                          ? "bg-[var(--panel-hover)] text-[var(--fg)]"
                          : "text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
                        showLimitsAttention ? "text-amber-900/80 dark:text-amber-200/80" : null,
                      )}
                      title={showLimitsAttention ? "Credits exhausted. Enable on-demand to continue." : undefined}
                      onClick={() => {
                        navigateToTab(t.id);
                        onNavigate?.();
                      }}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className={cn("shrink-0", active ? "text-[var(--fg)]" : "text-[var(--muted-2)]")} aria-hidden="true">
                          {TAB_ICON[t.id]}
                        </span>
                        <span className="flex min-w-0 items-center gap-2 truncate">
                          <span className="min-w-0 truncate">{t.label}</span>
                          {showLimitsAttention ? (
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500/65 dark:bg-amber-300/65" aria-hidden="true" />
                          ) : null}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
              {groupIdx < TAB_GROUPS.length - 1 ? <div className="my-3 h-px bg-[var(--border)]" /> : null}
            </div>
          ))}
        </nav>
        <div className="mt-6 h-px bg-[var(--border)]" />
        <div className="mt-3 px-1">
          <div className="grid gap-2">
            <button
              type="button"
              className="flex items-center gap-2 rounded-xl px-3 py-2 text-[13px] font-semibold text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]"
              onClick={() => {
                setContactOpen(true);
                onNavigate?.();
              }}
            >
              Contact Us
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-10 md:grid-cols-[280px_1fr]">
      <h1 className="sr-only">Dashboard</h1>

      {/* Mini dashboard menu (left) */}
      <aside className="hidden md:block md:sticky md:top-6 md:h-[calc(100svh-24px-24px)] md:overflow-auto">
        <DashboardMenu />
      </aside>

      {/* Content (right) */}
      <div className="min-w-0 space-y-10 pt-4 pb-2">
        {tab === "overview" ? (
          <Section title="Overview" description="A quick snapshot of your workspace.">
            <div className="grid gap-3">
              <SubscriptionCard />
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 sm:p-6">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <div className="text-[13px] font-semibold text-[var(--fg)]">All docs activity</div>
                    <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">
                      Last 30 days (UTC). Uploads, docs created, unique share views, and downloads.
                    </div>
                  </div>
                </div>

                <div className="mt-4 min-h-[280px] rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3">
                  {statsBusy ? (
                    <div className="h-[224px] w-full animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />
                  ) : stats && Array.isArray(stats.series30d) && stats.series30d.length ? (
                    <MultiLineChart30d series={stats.series30d} />
                  ) : (
                    <div className="px-2 py-2 text-[12px] text-[var(--muted-2)]">No data yet.</div>
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 sm:p-6">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <div className="text-[13px] font-semibold text-[var(--fg)]">This month</div>
                    <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">
                      Upload activity and sharing performance (last 30 days).
                    </div>
                  </div>
                  {statsBusy ? <div className="text-[12px] text-[var(--muted-2)]">Loading…</div> : null}
                </div>

                {statsError ? (
                  <Alert variant="error" className="mt-4 text-[12px]">
                    {statsError}
                  </Alert>
                ) : null}

                <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <StatCard
                    label="Pages viewed"
                    value={stats ? stats.sharing.pagesViewed30d : null}
                    hint="Pages viewed on docs created in the last 30 days"
                  />
                  <StatCard
                    label="New docs"
                    value={stats ? stats.docs.created30d : null}
                    hint="Docs created"
                  />
                  <StatCard label="Share views" value={stats ? stats.sharing.views30d : null} hint="Views on docs created in the last 30 days" />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 sm:p-6">
                  <div className="text-[13px] font-semibold text-[var(--fg)]">Library</div>
                  <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">Your active content in this workspace.</div>
                  <div className="mt-5 grid grid-cols-2 gap-3">
                    <StatMini label="Active docs" value={stats ? stats.docs.active : null} />
                    <StatMini label="Projects" value={stats ? stats.projects.active : null} />
                    <StatMini label="Request inboxes" value={stats ? stats.projects.requests : null} />
                    <StatMini label="All-time views" value={stats ? stats.sharing.viewsTotal : null} />
                  </div>
                </div>

                <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-4 sm:p-6">
                  <div className="text-[13px] font-semibold text-[var(--fg)]">Next up</div>
                  <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">
                    A few helpful ideas to get more leverage from LinkDrop.
                  </div>
                  <ul className="mt-4 grid gap-2 text-[13px] text-[var(--muted-2)]">
                    <li>• Share a doc and set a short password to track engagement.</li>
                    <li>• Enable “Allow download” only when needed to reduce uncontrolled forwarding.</li>
                    <li>• Create a request inbox to collect decks/docs into one place.</li>
                  </ul>
                </div>
              </div>
            </div>
          </Section>
        ) : null}

        {tab === "account" ? (
          <Section title="Account" description="Account-level settings and actions.">
            <div className="grid gap-3">
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 sm:p-6">
                <div className="text-[13px] font-semibold text-[var(--fg)]">Email preferences</div>
                <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">Applies to the currently selected workspace.</div>
                <div className="mt-4">
                  <NotificationPreferences />
                </div>
              </div>

              <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 sm:p-6">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="text-[13px] font-semibold text-[var(--fg)]">Delete account</div>
                    <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">
                      Permanently delete your account and associated data.
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled
                    className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[13px] font-semibold text-red-700 opacity-60"
                    title="Not implemented yet"
                  >
                    Delete account
                  </button>
                </div>
              </div>

              <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] px-5 py-4 text-[12px] text-[var(--muted-2)]">
                Coming soon. We’ll add a secure deletion flow once the backend endpoint is in place.
              </div>
            </div>
          </Section>
        ) : null}

        {tab === "workspace" ? (
          <Section title="Workspace" description="Create, switch, and manage workspaces.">
            <WorkspaceManager />
          </Section>
        ) : null}

        {tab === "teams" ? (
          <Section title="Teams" description="Manage members and invite links for your active workspace.">
            <TeamsManager />
          </Section>
        ) : null}

        {tab === "usage" ? (
          <Section title="Usage" description="Credits and quality breakdown.">
            <div className="grid gap-3">
              <SubscriptionCard />
              <DailyUsageChart days={usageDays} />
              <CreditsSummaryCard />
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 sm:p-6">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[12px] font-semibold text-[var(--muted-2)]">
                      Date range
                    </div>
                    <div className="inline-flex rounded-lg border border-[var(--border)] bg-[var(--panel)] p-1">
                      {([1, 7, 30] as const).map((d) => {
                        const active = usageDays === d;
                        return (
                          <button
                            key={d}
                            type="button"
                            className={cn(
                              "rounded-md px-3 py-1.5 text-[12px] font-semibold",
                              active
                                ? "bg-[var(--panel-hover)] text-[var(--fg)]"
                                : "text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
                            )}
                            onClick={() => setUsageDays(d)}
                          >
                            {d}d
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>

              <UsageTable days={usageDays} />
            </div>
          </Section>
        ) : null}

        {tab === "limits" ? (
          <Section
            title="Limits"
            description="On-demand controls and credit caps."
            helper={
              "On-demand limits are Pro-only."
            }
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <OnDemandUsageCard />
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 sm:p-6">
                <div className="flex items-start justify-between gap-3">
                  <div className="text-[13px] font-semibold text-[var(--fg)]">On-demand limit</div>
                  <HelpTooltip
                    label="What is the on-demand limit?"
                    body="This is your monthly cap for on-demand usage (extra credits). It resets each billing cycle and prevents unexpected overage."
                  />
                </div>
                <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">Enable on-demand usage and set a cap.</div>
                <div className="mt-4">
                  <SpendLimitModule />
                </div>
              </div>
            </div>

            <AiQualityDefaultsCard className="mt-3" />

            <div className="mt-3 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 sm:p-6">
              <div className="text-[13px] font-semibold text-[var(--fg)]">Deep Search Agent</div>
              <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">
                Deep-searches your document for companies, people, products, and potential risks.
              </div>
              <div className="mt-3 text-[13px] leading-6 text-[var(--muted-2)]">
                Deep Search Agent is currently being tested with only a few users. It’s very early access.{" "}
                If you’re interested in joining the waiting list to test it out, email us at{" "}
                <a className="font-semibold text-[var(--fg)] underline underline-offset-2" href="mailto:hi@lnkdrp.com">
                  hi@lnkdrp.com
                </a>
                .
              </div>
            </div>
          </Section>
        ) : null}

        {tab === "billing" ? (
          <BillingInvoicesTab />
        ) : null}
      </div>

      <Modal
        open={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
        ariaLabel="Dashboard menu"
        panelClassName="!left-0 !top-0 !translate-x-0 !translate-y-0 !h-[100svh] !w-[min(360px,calc(100vw-16px))] !rounded-none"
        contentClassName="max-h-[100svh] px-4 pb-6 pt-5"
      >
        <div className="text-[13px] font-semibold text-[var(--fg)]">Menu</div>
        <div className="mt-3">
          <DashboardMenu onNavigate={() => setMobileNavOpen(false)} />
        </div>
      </Modal>

      <Modal
        open={editNameOpen}
        onClose={() => {
          if (nameBusy) return;
          setEditNameOpen(false);
        }}
        ariaLabel="Edit your name"
      >
        <div className="text-[20px] font-semibold tracking-tight text-[var(--fg)]">Edit Your Name</div>
        <div className="mt-5 grid gap-4">
          <div>
            <label className="text-[12px] font-semibold text-[var(--fg)]" htmlFor="firstName">
              First Name <span className="text-red-600">*</span>
            </label>
            <input
              id="firstName"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-[14px] text-[var(--fg)] outline-none focus:border-[var(--muted-2)]"
              placeholder="First name"
              autoFocus
              disabled={nameBusy}
            />
          </div>
          <div>
            <label className="text-[12px] font-semibold text-[var(--fg)]" htmlFor="lastName">
              Last Name
            </label>
            <input
              id="lastName"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-[14px] text-[var(--fg)] outline-none focus:border-[var(--muted-2)]"
              placeholder="Last name"
              disabled={nameBusy}
            />
          </div>

          {nameError ? (
            <Alert variant="error" className="px-3 py-2 text-[12px]">
              {nameError}
            </Alert>
          ) : null}

          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              className="rounded-xl bg-[var(--panel-hover)] px-4 py-2 text-[13px] font-semibold text-[var(--fg)]"
              disabled={nameBusy}
              onClick={() => setEditNameOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-xl bg-[var(--fg)] px-4 py-2 text-[13px] font-semibold text-[var(--bg)] disabled:opacity-60"
              disabled={nameBusy}
              onClick={() => {
                setNameError(null);
                void (async () => {
                  try {
                    const f = firstName.trim();
                    const l = lastName.trim();
                    if (!f) {
                      setNameError("First name is required.");
                      return;
                    }
                    setNameBusy(true);
                    const res = await fetch("/api/users/me/name", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ firstName: f, lastName: l }),
                    });
                    const data = (await res.json().catch(() => null)) as { ok?: boolean; name?: string; error?: string } | null;
                    if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
                    const nextName = typeof data?.name === "string" ? data.name.trim() : "";
                    if (!nextName) throw new Error("Invalid response");
                    // Update NextAuth session so the UI re-renders immediately.
                    await updateSession({ user: { name: nextName } } as any);
                    setEditNameOpen(false);
                  } catch (e) {
                    const msg = e instanceof Error ? e.message : "Failed to update name";
                    setNameError(msg);
                  } finally {
                    setNameBusy(false);
                  }
                })();
              }}
            >
              Save
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={contactOpen} onClose={() => setContactOpen(false)} ariaLabel="Contact us">
        <div className="text-[20px] font-semibold tracking-tight text-[var(--fg)]">Contact Us</div>
        <div className="mt-3 text-[13px] leading-6 text-[var(--muted-2)]">
          For all support inquiries, including billing issues, receipts, and general assistance, please email{" "}
          <a className="font-semibold text-[var(--fg)] underline underline-offset-2" href="mailto:hi@lnkdrp.com">
            hi@lnkdrp.com
          </a>
          .
        </div>
      </Modal>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | null;
  hint?: string;
}) {
  return (
    <div className="rounded-xl bg-[var(--panel-2)] p-4">
      <div className="text-[12px] font-semibold text-[var(--muted-2)]">{label}</div>
      <div className="mt-2 text-[26px] font-semibold tracking-tight text-[var(--fg)]">
        {typeof value === "number" ? value.toLocaleString() : "—"}
      </div>
      {hint ? <div className="mt-1 text-[12px] text-[var(--muted-2)]">{hint}</div> : null}
    </div>
  );
}

function StatMini({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-xl bg-[var(--panel-hover)] p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">{label}</div>
      <div className="mt-1 text-[16px] font-semibold text-[var(--fg)]">
        {typeof value === "number" ? value.toLocaleString() : "—"}
      </div>
    </div>
  );
}

