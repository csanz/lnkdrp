/**
 * Page for `/preferences` — standalone preferences hub (no app sidebar).
 */

"use client";

import WorkspaceManager from "./WorkspaceManager";
import NotificationPreferences from "./NotificationPreferences";
import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/cn";
import {
  BanknotesIcon,
  ChartBarIcon,
  Cog6ToothIcon,
  CreditCardIcon,
  UserCircleIcon,
} from "@heroicons/react/24/outline";

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
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
      <div className="text-[15px] font-semibold text-[var(--fg)]">{title}</div>
      <div className="mt-1 text-[12px] text-[var(--muted-2)]">{description}</div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

type PrefTab = "account" | "workspace" | "usage" | "spending" | "billing";

const TABS: Array<{ id: PrefTab; label: string }> = [
  { id: "account", label: "Account" },
  { id: "workspace", label: "Workspace" },
  { id: "usage", label: "Usage" },
  { id: "spending", label: "Spending" },
  { id: "billing", label: "Billing" },
];

const TAB_ICON: Record<PrefTab, React.ReactNode> = {
  account: <UserCircleIcon className="h-4 w-4" />,
  workspace: <Cog6ToothIcon className="h-4 w-4" />,
  usage: <ChartBarIcon className="h-4 w-4" />,
  spending: <BanknotesIcon className="h-4 w-4" />,
  billing: <CreditCardIcon className="h-4 w-4" />,
};

function isPrefTab(v: unknown): v is PrefTab {
  return v === "account" || v === "workspace" || v === "usage" || v === "spending" || v === "billing";
}

function tabFromSearchParams(searchParams: URLSearchParams | null): PrefTab {
  const raw = searchParams?.get("tab") ?? "";
  return isPrefTab(raw) ? raw : "account";
}

function PlaceholderTile({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-4">
      <div className="text-[13px] font-semibold text-[var(--fg)]">{title}</div>
      <div className="mt-1 text-[12px] text-[var(--muted-2)]">{body}</div>
      <div className="mt-3 h-10 rounded-lg bg-[var(--panel-hover)]" aria-hidden="true" />
    </div>
  );
}

export default function PreferencesPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = tabFromSearchParams(searchParams);

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[240px_1fr]">
      {/* Mini preferences menu (left) */}
      <aside className="md:sticky md:top-4 md:h-[calc(100svh-16px-16px)] md:overflow-auto">
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-3">
          <div className="px-2 pb-2 pt-1">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
              Preferences
            </div>
          </div>
          <nav className="space-y-1">
            {TABS.map((t) => {
              const active = t.id === tab;
              return (
                <button
                  key={t.id}
                  type="button"
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-[13px] font-semibold",
                    active
                      ? "border border-[var(--border)] bg-[var(--panel-hover)] text-[var(--fg)]"
                      : "border border-transparent text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
                  )}
                  onClick={() => {
                    const href = `/preferences?tab=${encodeURIComponent(t.id)}`;
                    router.push(href, { scroll: false });
                  }}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className={cn(
                        "shrink-0",
                        active ? "text-[var(--fg)]" : "text-[var(--muted-2)]",
                      )}
                      aria-hidden="true"
                    >
                      {TAB_ICON[t.id]}
                    </span>
                    <span className="min-w-0 truncate">{t.label}</span>
                  </span>
                </button>
              );
            })}
          </nav>
        </div>
      </aside>

      {/* Content (right) */}
      <div className="min-w-0 space-y-6">
        <header>
          <h1 className="text-[22px] font-semibold text-[var(--fg)]">Preferences</h1>
          <p className="mt-1 text-[13px] text-[var(--muted-2)]">Account, workspace, and billing settings.</p>
        </header>

        {tab === "account" ? (
          <Section title="Account" description="Account-level settings and actions.">
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
            <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-[12px] text-[var(--muted-2)]">
              Coming soon. We’ll add a secure deletion flow once the backend endpoint is in place.
            </div>
          </Section>
        ) : null}

        {tab === "workspace" ? (
          <Section title="Workspace" description="Organization and membership management.">
            <WorkspaceManager />
            <div className="mt-4">
              <NotificationPreferences />
            </div>
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
          <Section title="Billing" description="Invoices and subscription.">
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
                className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] font-semibold text-[var(--muted-2)] opacity-60"
                title="Not implemented yet"
              >
                Manage billing
              </button>
            </div>
            <div className="mt-3 text-[12px] text-[var(--muted-2)]">
              We’ll wire this up to Stripe (or your billing system) when ready.
            </div>
          </Section>
        ) : null}
      </div>
    </div>
  );
}


