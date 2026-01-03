/**
 * Page for `/dashboard` — standalone dashboard hub (overview/account/workspace/teams/usage/spending/billing).
 */
"use client";

import WorkspaceManager from "./WorkspaceManager";
import TeamsManager from "./TeamsManager";
import SubscriptionCard from "./SubscriptionCard";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import { ORGS_CACHE_UPDATED_EVENT, readOrgsCacheSnapshot, refreshOrgsCache } from "@/lib/orgsCache";
import Modal from "@/components/modals/Modal";
import Alert from "@/components/ui/Alert";
import IconButton from "@/components/ui/IconButton";
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

function clsx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="text-[24px] font-semibold tracking-tight text-[var(--fg)]">{title}</div>
      <div className="mt-1.5 text-[13px] text-[var(--muted-2)]">{description}</div>
      <div className="mt-7">{children}</div>
    </section>
  );
}

type DashTab = "overview" | "account" | "workspace" | "teams" | "usage" | "spending" | "billing";

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
      { id: "spending", label: "Spending" },
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
  spending: <BanknotesIcon className="h-4 w-4" />,
  billing: <CreditCardIcon className="h-4 w-4" />,
};

function isDashTab(v: unknown): v is DashTab {
  return (
    v === "overview" ||
    v === "account" ||
    v === "workspace" ||
    v === "teams" ||
    v === "usage" ||
    v === "spending" ||
    v === "billing"
  );
}

function tabFromSearchParams(searchParams: URLSearchParams | null): DashTab {
  const raw = searchParams?.get("tab") ?? "";
  return isDashTab(raw) ? raw : "overview";
}

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
  const tab = tabFromSearchParams(searchParams);
  const { data: session, update: updateSession } = useSession();

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
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [statsBusy, setStatsBusy] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);

  const userKey = useMemo(() => (session?.user?.email ?? "").trim(), [session?.user?.email]);

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
    setStatsBusy(true);
    setStatsError(null);
    void (async () => {
      try {
        const res = await fetch("/api/dashboard/stats", { method: "GET" });
        const data = (await res.json().catch(() => null)) as DashboardStats | { error?: string } | null;
        if (!res.ok) throw new Error((data as any)?.error || `Request failed (${res.status})`);
        if (!data || (data as any).ok !== true) throw new Error("Invalid response");
        if (!cancelled) setStats(data as DashboardStats);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to load stats";
        if (!cancelled) setStatsError(msg);
      } finally {
        if (!cancelled) setStatsBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab]);

  return (
    <div className="grid grid-cols-1 gap-10 md:grid-cols-[280px_1fr]">
      <h1 className="sr-only">Dashboard</h1>

      {/* Mini dashboard menu (left) */}
      <aside className="md:sticky md:top-6 md:h-[calc(100svh-24px-24px)] md:overflow-auto">
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
                }}
              >
                <PencilSquareIcon className="h-4 w-4" aria-hidden="true" />
              </IconButton>
            </div>
            {email ? <div className="mt-0.5 truncate text-[12px] text-[var(--muted-2)]">{email}</div> : null}
          </div>
          <div className="my-3 h-px bg-[var(--border)]" />
          <nav className="grid gap-2">
            {TAB_GROUPS.map((g, groupIdx) => (
              <div key={groupIdx}>
                <div className="grid">
                  {g.items.map((t) => {
                    const active = t.id === tab;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        className={clsx(
                          "flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-[13px] font-semibold",
                          active
                            ? "bg-[var(--panel-hover)] text-[var(--fg)]"
                            : "text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
                        )}
                        onClick={() => {
                          const href = `/dashboard?tab=${encodeURIComponent(t.id)}`;
                          router.push(href, { scroll: false });
                        }}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            className={clsx("shrink-0", active ? "text-[var(--fg)]" : "text-[var(--muted-2)]")}
                            aria-hidden="true"
                          >
                            {TAB_ICON[t.id]}
                          </span>
                          <span className="min-w-0 truncate">{t.label}</span>
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
                onClick={() => setContactOpen(true)}
              >
                Contact Us
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* Content (right) */}
      <div className="min-w-0 space-y-10 pt-4 pb-2">
        {tab === "overview" ? (
          <Section title="Overview" description="A quick snapshot of your workspace.">
            <div className="grid gap-3">
              <SubscriptionCard />
              <div className="rounded-2xl bg-[var(--panel)] p-6">
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

              <div className="rounded-2xl bg-[var(--panel)] p-6">
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

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="rounded-2xl bg-[var(--panel)] p-6">
                  <div className="text-[13px] font-semibold text-[var(--fg)]">Library</div>
                  <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">Your active content in this workspace.</div>
                  <div className="mt-5 grid grid-cols-2 gap-3">
                    <StatMini label="Active docs" value={stats ? stats.docs.active : null} />
                    <StatMini label="Projects" value={stats ? stats.projects.active : null} />
                    <StatMini label="Request inboxes" value={stats ? stats.projects.requests : null} />
                    <StatMini label="All-time views" value={stats ? stats.sharing.viewsTotal : null} />
                  </div>
                </div>

                <div className="rounded-2xl bg-[var(--panel-2)] p-6">
                  <div className="text-[13px] font-semibold text-[var(--fg)]">Next up</div>
                  <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">
                    A few helpful ideas to get more leverage from LinkDrop.
                  </div>
                  <ul className="mt-4 grid gap-2 text-[13px] text-[var(--muted-2)]">
                    <li>• Share a doc with a short password to track engagement.</li>
                    <li>• Create a request inbox to collect decks into one place.</li>
                    <li>• Add a project description to help auto-organize uploads.</li>
                  </ul>
                </div>
              </div>
            </div>
          </Section>
        ) : null}

        {tab === "account" ? (
          <Section title="Account" description="Account-level settings and actions.">
            <div className="grid gap-3">
              <div className="rounded-2xl bg-[var(--panel)] p-6">
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

              <div className="rounded-2xl bg-[var(--panel-2)] px-5 py-4 text-[12px] text-[var(--muted-2)]">
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
          <Section title="Usage" description="Tokens and usage breakdown.">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <PlaceholderTile title="By model" body="Daily usage chart + per-model totals." />
              <PlaceholderTile title="Included usage" body="Plan allowance + breakdown by product." />
            </div>
          </Section>
        ) : null}

        {tab === "spending" ? (
          <Section title="Spending" description="Spend limits and on-demand tracking.">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <PlaceholderTile title="On-demand usage" body="Month-to-date + progress towards limit." />
              <PlaceholderTile title="Spend limit" body="Set a monthly cap for on-demand usage." />
            </div>
          </Section>
        ) : null}

        {tab === "billing" ? (
          <Section title="Billing & Invoices" description="Invoices and subscription.">
            <div className="grid gap-3">
              <div className="rounded-2xl bg-[var(--panel)] p-6">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="text-[13px] font-semibold text-[var(--fg)]">Manage subscription</div>
                    <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">
                      Open billing portal to view invoices and update payment method.
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled
                    className="rounded-lg bg-[var(--panel-hover)] px-3 py-2 text-[13px] font-semibold text-[var(--muted-2)] opacity-60"
                    title="Not implemented yet"
                  >
                    Manage billing
                  </button>
                </div>
              </div>

              <div className="rounded-2xl bg-[var(--panel-2)] px-5 py-4 text-[12px] text-[var(--muted-2)]">
                We’ll wire this up to Stripe (or your billing system) when ready.
              </div>
            </div>
          </Section>
        ) : null}
      </div>

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

function MultiLineChart30d({
  series,
}: {
  series: Array<{ day: string; docsCreated: number; uploadsCreated: number; shareUniqueViews: number; shareDownloads: number }>;
}) {
  const safe = Array.isArray(series) ? series : [];
  const labels = safe.map((s) => s.day);
  const docs = safe.map((s) => (typeof s.docsCreated === "number" ? s.docsCreated : 0));
  const uploads = safe.map((s) => (typeof s.uploadsCreated === "number" ? s.uploadsCreated : 0));
  const views = safe.map((s) => (typeof s.shareUniqueViews === "number" ? s.shareUniqueViews : 0));
  const downloads = safe.map((s) => (typeof s.shareDownloads === "number" ? s.shareDownloads : 0));

  const max = Math.max(1, ...docs, ...uploads, ...views, ...downloads);
  const n = Math.max(2, safe.length);

  const BASELINE_Y = 29;
  const TOP_Y = 1;
  const RANGE_Y = BASELINE_Y - TOP_Y;

  const pointsFor = (values: number[]) =>
    values.map((v, i) => {
      const x = (i * 100) / (n - 1);
      const y = BASELINE_Y - (Math.max(0, v) / max) * RANGE_Y;
      return { x, y };
    });

  function smoothPath(pts: Array<{ x: number; y: number }>) {
    if (!pts.length) return "";
    if (pts.length === 1) return `M ${pts[0]!.x.toFixed(2)} ${pts[0]!.y.toFixed(2)}`;
    const clampY = (y: number) => Math.min(BASELINE_Y, Math.max(TOP_Y, y));
    let d = `M ${pts[0]!.x.toFixed(2)} ${pts[0]!.y.toFixed(2)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] ?? pts[i]!;
      const p1 = pts[i]!;
      const p2 = pts[i + 1]!;
      const p3 = pts[i + 2] ?? p2;
      const c1x = p1.x + (p2.x - p0.x) / 6;
      const c1y = clampY(p1.y + (p2.y - p0.y) / 6);
      const c2x = p2.x - (p3.x - p1.x) / 6;
      const c2y = clampY(p2.y - (p3.y - p1.y) / 6);
      d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)} ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
    }
    return d;
  }

  const lines: Array<{ key: string; label: string; stroke: string; values: number[] }> = [
    { key: "uploads", label: "Uploads", stroke: "rgb(59 130 246)", values: uploads },
    { key: "docs", label: "Docs created", stroke: "rgb(16 185 129)", values: docs },
    { key: "views", label: "Unique share views", stroke: "rgb(168 85 247)", values: views },
    { key: "downloads", label: "Share downloads", stroke: "rgb(34 197 94)", values: downloads },
  ];

  const left = labels[0] ?? "";
  const mid = labels[Math.floor(labels.length / 2)] ?? "";
  const right = labels[labels.length - 1] ?? "";

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1 pb-2 text-[11px] text-[var(--muted-2)]">
        {lines.map((l) => (
          <div key={l.key} className="inline-flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: l.stroke }} aria-hidden="true" />
            <span>{l.label}</span>
          </div>
        ))}
        <div className="ml-auto text-[11px] text-[var(--muted-2)]">Max: {max.toLocaleString()}</div>
      </div>

      <svg viewBox="0 0 100 30" className="h-56 w-full">
        <path d={`M 0 ${BASELINE_Y} L 100 ${BASELINE_Y}`} stroke="currentColor" strokeOpacity="0.35" strokeWidth="0.75" fill="none" />
        <path d={`M 0 ${TOP_Y} L 100 ${TOP_Y}`} stroke="currentColor" strokeOpacity="0.15" strokeWidth="0.5" fill="none" />
        <path d={`M 0 ${(TOP_Y + BASELINE_Y) / 2} L 100 ${(TOP_Y + BASELINE_Y) / 2}`} stroke="currentColor" strokeOpacity="0.15" strokeWidth="0.5" fill="none" />

        {lines.map((l) => {
          const pts = pointsFor(l.values);
          const d = pts.length ? smoothPath(pts) : `M 0 ${BASELINE_Y} L 100 ${BASELINE_Y}`;
          return (
            <path
              key={l.key}
              d={d}
              stroke={l.stroke}
              strokeWidth="0.9"
              fill="none"
              strokeLinejoin="round"
              strokeLinecap="round"
              shapeRendering="geometricPrecision"
            />
          );
        })}
      </svg>

      <div className="mt-2 flex justify-between px-1 text-[10px] text-[var(--muted-2)] tabular-nums">
        <span>{left}</span>
        <span>{mid}</span>
        <span>{right}</span>
      </div>
    </div>
  );
}


