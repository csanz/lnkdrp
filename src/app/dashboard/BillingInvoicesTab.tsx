/**
 * Billing & Invoices tab content for `/dashboard?tab=billing` (and `/dashboard/billing` via redirect).
 *
 * Cursor-style layout:
 * - Included Usage (the selected cycle)
 * - On-Demand Usage (the selected cycle; its Period selector drives both tables)
 * - Invoices (month selector + View links)
 */
"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import Panel from "@/components/ui/Panel";
import DataTable from "@/components/ui/DataTable";
import Select from "@/components/ui/Select";
import Alert from "@/components/ui/Alert";
import Modal from "@/components/modals/Modal";
import { CopyButton } from "@/components/CopyButton";
import { UNLIMITED_LIMIT_CENTS } from "@/lib/billing/limits";
import { debugEnabled as isDebugEnabled } from "@/lib/debug";
import { clampNonNegInt, formatInt } from "@/lib/format/number";
import { formatDateRange, formatMonthLabel, formatShortDate } from "@/lib/format/date";
import { formatUsdFromCents, formatUsdOrNotAvailable } from "@/lib/format/money";
import { openBillingPortal, resumeSubscription } from "@/lib/billing/clientActions";
import { CREDITS_COPY, comparesFor } from "@/lib/client/planLimit";
import { usePlan } from "@/lib/client/usePlan";
import WorkspaceIcon from "@/components/WorkspaceIcon";

/** The workspace this tab bills, from `/api/billing/status`. */
type BilledWorkspace = {
  name: string | null;
  avatarUrl: string | null;
  plan: "free" | "pro";
  payg: boolean;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

/**
 * Which workspace is being billed. Every workspace is its own Stripe customer with its own plan,
 * credits and invoices, and a new team workspace starts on Free even when the personal one is on
 * Pro; without this the tab read as the account's billing, and it was unclear what a new
 * subscription would pay for.
 */
function BilledWorkspaceHeader({
  workspace,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  isPersonal: _isPersonal,
  canManageBilling,
  manageBusy,
  onManage,
  cancelBusy,
  onCancel,
  resumeBusy,
  onResume,
}: {
  workspace: BilledWorkspace | null;
  isPersonal: boolean;
  /** Owner or admin: cancelling and resuming are theirs. */
  canManageBilling: boolean;
  manageBusy: boolean;
  onManage: () => void;
  cancelBusy: boolean;
  onCancel: () => void;
  resumeBusy: boolean;
  onResume: () => void;
}) {
  const name = workspace?.name ?? "This workspace";
  const initial = name.trim().charAt(0).toUpperCase() || "W";
  const isPro = workspace?.plan === "pro";
  // A cancelled Pro subscription stays Pro until the paid period ends. This used to read "Ends Oct 16."
  // in muted text next to a Pro badge, so a person who had just cancelled saw nothing change.
  const ending = isPro && Boolean(workspace?.cancelAtPeriodEnd);
  const endDate = workspace?.periodEnd ? formatShortDate(workspace.periodEnd) : "";
  const hasSubscription = isPro || Boolean(workspace?.payg);
  const planLabel = ending ? (endDate ? `Pro until ${endDate}` : "Pro, ending") : isPro ? "Pro" : workspace?.payg ? "Free, pay-as-you-go" : "Free";
  const renewal = isPro && !ending && endDate ? `Renews ${endDate}. ` : "";
  const secondaryButton =
    "rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-60";

  return (
    <Panel padding="lg">
      <div className="flex flex-wrap items-center gap-4">
        <WorkspaceIcon
          avatarUrl={workspace?.avatarUrl}
          fallback={workspace ? initial : ""}
          className="h-11 w-11"
          fallbackClassName="bg-[var(--panel-hover)] text-base text-[var(--fg)]"
        />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] text-[var(--muted-2)]">Billing for</div>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-2">
            {workspace ? (
              <>
                <span className="truncate text-[18px] font-semibold tracking-tight text-[var(--fg)]">{name}</span>
                <span
                  className={
                    ending
                      ? "rounded-full bg-[var(--plan-ending-bg)] px-2 py-0.5 text-[11px] font-semibold text-[var(--plan-ending-fg)]"
                      : isPro
                        ? "rounded-full bg-[var(--fg)] px-2 py-0.5 text-[11px] font-semibold text-[var(--bg)]"
                        : "rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] font-semibold text-[var(--muted-2)]"
                  }
                >
                  {planLabel}
                </span>
              </>
            ) : (
              <SkeletonPill widthClassName="w-40" />
            )}
          </div>
          <div className="mt-1 text-[12px] text-[var(--muted-2)]">
            {renewal}
            {`${name} is billed on its own, with its own plan, credits and invoices. Your other workspaces are not affected.`}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/dashboard?tab=workspace" className={secondaryButton}>
            Switch workspace
          </Link>
          {!workspace ? null : hasSubscription ? (
            <button type="button" className={secondaryButton} onClick={onManage} disabled={manageBusy}>
              {manageBusy ? "Opening…" : "Manage subscription"}
            </button>
          ) : (
            <Link
              href="/pricing"
              className="rounded-xl bg-[var(--fg)] px-3 py-2 text-[13px] font-semibold text-[var(--bg)] hover:opacity-90"
            >
              Upgrade {name} to Pro
            </Link>
          )}
        </div>
      </div>

      {ending ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[var(--plan-ending-bg)] px-4 py-3">
          <div className="min-w-0 flex-1 text-[13px] leading-5 text-[var(--fg)]">
            <span className="font-semibold text-[var(--plan-ending-fg)]">Pro is cancelled.</span>{" "}
            {name} keeps Pro {endDate ? `until ${endDate}` : "until the end of this billing period"}, then moves to Free. It
            won&apos;t renew.
          </div>
          {canManageBilling ? (
            <button
              type="button"
              className="shrink-0 rounded-xl bg-[var(--fg)] px-3 py-2 text-[13px] font-semibold text-[var(--bg)] hover:opacity-90 disabled:opacity-60"
              onClick={onResume}
              disabled={resumeBusy}
            >
              {resumeBusy ? "Resuming…" : "Resume Pro"}
            </button>
          ) : null}
        </div>
      ) : isPro && canManageBilling ? (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            className="text-[12px] font-semibold text-[var(--muted-2)] underline-offset-2 hover:text-[var(--fg)] hover:underline disabled:opacity-60"
            onClick={onCancel}
            disabled={cancelBusy}
          >
            {cancelBusy ? "Opening…" : "Cancel subscription"}
          </button>
        </div>
      ) : null}
    </Panel>
  );
}

type BillingSummary = {
  cycle: { start: string; end: string; key: string };
  plan: { name: string; status: string; cancelAtPeriodEnd: boolean };
  onDemand: { enabled: boolean; monthlyLimitCents: number; usedCentsThisCycle: number };
  balances: { includedRemaining: number; purchasedRemaining: number; trialRemaining: number; creditsRemaining: number };
};

/** Ledger bucket a usage row was drawn from, when the API reports it. */
type LedgerBucket = "trial" | "subscription" | "purchased" | "on_demand";

/**
 * Customer-facing bucket names. The ledger's `trial` bucket is the one-time starter grant every
 * Free workspace begins with, so it reads "Starter" in the UI, never "Trial".
 */
const BUCKET_LABELS: Record<LedgerBucket, string> = {
  trial: "Starter",
  subscription: "Included",
  purchased: "Purchased",
  on_demand: "On-demand",
};

/**
 * Display label for a ledger row: appends the bucket name when the row carries one, and rewrites
 * a bare "Trial" that arrived inside the label text so the starter grant never reads as a trial.
 */
function ledgerRowLabel(row: { label: string; bucket?: LedgerBucket | string | null }): string {
  const bucket = typeof row.bucket === "string" ? row.bucket.trim().toLowerCase() : "";
  const bucketLabel = bucket in BUCKET_LABELS ? BUCKET_LABELS[bucket as LedgerBucket] : bucket ? bucket : "";
  const base = row.label.replace(/\bTrial\b/g, "Starter");
  return bucketLabel && !base.includes(bucketLabel) ? `${base} · ${bucketLabel}` : base;
}

type BillingUsage = {
  cycle: { start: string; end: string };
  included: {
    rows: Array<{ label: string; bucket?: LedgerBucket | string | null; credits: number; costCents: number; costLabel: string }>;
    total: { label: string; credits: number; costCents: number; costLabel: string };
  };
  onDemand: {
    usedCents: number;
    limitCents: number;
    rows: Array<{
      label: string;
      bucket?: LedgerBucket | string | null;
      credits: number;
      costCents: number | null;
      qty: number;
      totalCents: number | null;
    }>;
    adjustments: Array<{ description: string; totalCents: number }>;
    subtotalCents: number;
  };
};

type BillingInvoices = {
  months: string[];
  selectedMonth: string;
  invoices: Array<{
    date: string;
    description: string;
    status: string;
    amountCents: number;
    currency: string;
    hostedInvoiceUrl: string | null;
  }>;
};

// Small in-memory cache to avoid re-fetching when navigating between dashboard tabs.
// Billing is relatively expensive (Stripe + large ledger scans), so this keeps the UI snappy.
const BILLING_CACHE_TTL_MS = 30_000;
type BillingCache = {
  at: number;
  summary: BillingSummary | null;
  usageByCycleStart: Record<string, BillingUsage>;
  invoicesByMonth: Record<string, BillingInvoices>;
};
let billingCache: BillingCache | null = null;

function billingCacheFresh(now = Date.now()): BillingCache | null {
  if (!billingCache) return null;
  if (now - billingCache.at > BILLING_CACHE_TTL_MS) return null;
  return billingCache;
}

function writeBillingCache(update: Partial<BillingCache>) {
  const prev = billingCache ?? { at: 0, summary: null, usageByCycleStart: {}, invoicesByMonth: {} };
  billingCache = {
    at: Date.now(),
    summary: update.summary ?? prev.summary,
    usageByCycleStart: update.usageByCycleStart ?? prev.usageByCycleStart,
    invoicesByMonth: update.invoicesByMonth ?? prev.invoicesByMonth,
  };
}

function SkeletonLines({ lines = 3 }: { lines?: number }) {
  return (
    <div className="grid gap-2" aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="h-4 w-full rounded-lg bg-[var(--panel-hover)]" />
      ))}
    </div>
  );
}

function SkeletonPill({ widthClassName = "w-36" }: { widthClassName?: string }) {
  return <div className={`inline-block h-4 ${widthClassName} rounded-lg bg-[var(--panel-hover)]`} aria-hidden="true" />;
}

function CreditsInfo({ className }: { className?: string }) {
  return (
    <div className={className}>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3 text-[12px] text-[var(--muted-2)]">
        <div className="font-semibold text-[var(--fg)]">What are credits?</div>
        <div className="mt-1">
          Credits are how we measure AI usage across quality tiers. You’ll always see credits first. Dollars only apply
          to on-demand.
        </div>
      </div>
    </div>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Do two ISO strings name the same instant?
 *
 * Compared as timestamps, not as text: the cycle start the selector holds comes from
 * `/api/billing/summary` (or from `cycleOptions` below) while the one we check it against comes
 * back from `/api/billing/usage`, and two servers round-tripping the same instant can still spell
 * it differently.
 */
function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb;
}

/**
 * `base` moved by whole calendar months in UTC, clamping the day to the target month's length the
 * way Stripe clamps a billing anchor: a subscription anchored on the 31st bills Feb 28.
 */
function shiftMonthsUtc(base: Date, anchorDay: number, months: number): Date {
  const firstOfTarget = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + months, 1));
  const y = firstOfTarget.getUTCFullYear();
  const m = firstOfTarget.getUTCMonth();
  // Day 0 of the next month is the last day of this one.
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      y,
      m,
      Math.min(anchorDay, daysInMonth),
      base.getUTCHours(),
      base.getUTCMinutes(),
      base.getUTCSeconds(),
      base.getUTCMilliseconds(),
    ),
  );
}

/** "2026-08" for an instant, in the same UTC month key `/api/billing/invoices` reports. */
function monthKeyUtc(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function formatJson(v: unknown) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export default function BillingInvoicesTab() {
  const cached = billingCacheFresh();

  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summary, setSummary] = useState<BillingSummary | null>(() => cached?.summary ?? null);

  const [usageBusy, setUsageBusy] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [usage, setUsage] = useState<BillingUsage | null>(() => {
    const start = cached?.summary?.cycle?.start;
    if (!start) return null;
    return cached?.usageByCycleStart?.[start] ?? null;
  });

  const [invoicesBusy, setInvoicesBusy] = useState(false);
  const [invoicesError, setInvoicesError] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<BillingInvoices | null>(() => {
    const key = cached?.invoicesByMonth?.["__default__"] ? "__default__" : "";
    return key ? cached!.invoicesByMonth[key] : null;
  });

  /**
   * Oldest month `/api/billing/invoices` has reported in this session, as a `YYYY-MM` key.
   *
   * Only ever moves backwards. The route recomputes `months` from the invoices it just listed, so
   * asking it for one month narrows the list it answers with; if the period selector read that
   * narrowed list directly it would drop options — possibly the one the user is looking at — the
   * moment they picked an invoice month. Keeping the widest boundary we have seen makes the
   * selector's length stable for the life of the tab.
   */
  const [oldestInvoiceMonth, setOldestInvoiceMonth] = useState("");
  const [cycleStartIso, setCycleStartIso] = useState<string | null>(() => cached?.summary?.cycle?.start ?? null);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(() => cached?.invoicesByMonth?.["__default__"]?.selectedMonth ?? null);
  const [manageBusy, setManageBusy] = useState(false);
  const [workspace, setWorkspace] = useState<BilledWorkspace | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [billingNotice, setBillingNotice] = useState<string | null>(null);
  const { plan: planSnapshot } = usePlan();
  /** Same rule the server now enforces on /api/billing/invoices, and the same one SubscriptionCard uses. */
  const canManageBilling = planSnapshot?.role === "owner" || planSnapshot?.role === "admin";
  const [manageError, setManageError] = useState<string | null>(null);
  const [creditsInfoOpen, setCreditsInfoOpen] = useState(false);
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugBusy, setDebugBusy] = useState(false);
  const [debugError, setDebugError] = useState<string | null>(null);
  const [debugPayload, setDebugPayload] = useState<unknown>(null);
  const [debugCopyDone, setDebugCopyDone] = useState(false);
  const [debugCopying, setDebugCopying] = useState(false);

  /**
   * The periods the selector offers, on real month boundaries.
   *
   * This used to walk backwards by a fixed `start - i * periodMs` using the current cycle's length.
   * Stripe's monthly cycles are 28–31 days, so every earlier option drifted further from the
   * invoice it claimed to be: a workspace billed Mar 1 → Apr 1 was offered "Period starting Jan 29"
   * for what Stripe billed as Feb 1 → Mar 1, the label named a date that matched no invoice, and
   * the usage fetch pulled three days of January into a period the reader believed was February.
   * Six options back the drift compounded to about a week.
   *
   * Stripe anchors a monthly subscription on a day of the month and clamps it to the last day of
   * shorter months, so stepping whole calendar months back from the current start — with the same
   * clamping — reproduces the real boundaries. The anchor is the larger of the current start and
   * end day, because a start that landed in a short month is itself already clamped: Jan 31 →
   * Feb 28 → Mar 31 is anchor 31, and reading 28 off the February start would misdate January.
   *
   * How far back: the invoice months this tab already fetched, when we have them, since they are
   * the only real evidence of how long this workspace has been billed. The cut-off compares the
   * period's END month so that it holds whether Stripe invoiced the period in advance or in
   * arrears. With no invoice history (a Free workspace, or a member who may not read invoices) we
   * keep the previous six, which are at least correctly dated now.
   *
   * A window that is not roughly a month long — an annual plan — gets the current period alone,
   * because it has no month boundaries to walk and inventing five is what this code was doing
   * wrong in the first place. The rolling 30-day window `/api/billing/usage` falls back to when no
   * subscription period is stored does count as monthly here: it has no real boundaries either
   * way, and each option still fetches exactly the range its label names.
   */
  const cycleOptions = useMemo(() => {
    const start = summary?.cycle?.start;
    const end = summary?.cycle?.end;
    if (!start || !end) return [];
    const s = new Date(start);
    const e = new Date(end);
    if (!Number.isFinite(s.getTime()) || !Number.isFinite(e.getTime())) return [{ start, end, label: "Current period" }];

    // The current period keeps the summary's own strings, so the <Select>'s value always matches an
    // option and the usage effect can find this entry to read its `end` from.
    const out: Array<{ start: string; end: string; label: string }> = [{ start, end, label: "Current period" }];

    const periodMs = e.getTime() - s.getTime();
    const monthly = periodMs >= 27 * DAY_MS && periodMs <= 32 * DAY_MS;
    if (!monthly) return out;

    const anchorDay = Math.max(s.getUTCDate(), e.getUTCDate());
    for (let i = 1; i < 6; i++) {
      const cs = shiftMonthsUtc(s, anchorDay, -i);
      const ce = shiftMonthsUtc(s, anchorDay, -i + 1);
      if (ce.getTime() <= cs.getTime()) break;
      out.push({ start: cs.toISOString(), end: ce.toISOString(), label: formatDateRange(cs.toISOString(), ce.toISOString()) });
    }

    // Trim after building rather than stopping the loop, so the period the user is currently
    // reading survives invoices arriving late and moving the cut-off up past it.
    let keep = out.length;
    if (oldestInvoiceMonth) {
      const firstUnbilled = out.findIndex((o, idx) => idx > 0 && monthKeyUtc(new Date(o.end)) < oldestInvoiceMonth);
      if (firstUnbilled > 0) keep = firstUnbilled;
    }
    const selectedIdx = out.findIndex((o) => sameInstant(o.start, cycleStartIso));
    if (selectedIdx >= keep) keep = selectedIdx + 1;
    return keep >= out.length ? out : out.slice(0, keep);
  }, [summary?.cycle?.start, summary?.cycle?.end, oldestInvoiceMonth, cycleStartIso]);

  const loadWorkspace = useCallback(async (fresh = false): Promise<BilledWorkspace | null> => {
    try {
      const res = await fetch(`/api/billing/status${fresh ? "?fresh=1" : ""}`, { cache: "no-store" });
      const json = (await res.json().catch(() => null)) as {
        org?: { name?: string | null; avatarUrl?: string | null };
        plan?: string;
        payg?: boolean;
        stripeCurrentPeriodEnd?: string | null;
        stripeCancelAtPeriodEnd?: boolean;
      } | null;
      if (!res.ok || !json) return null;
      const next: BilledWorkspace = {
        name: json.org?.name ?? null,
        avatarUrl: json.org?.avatarUrl ?? null,
        plan: json.plan === "pro" ? "pro" : "free",
        payg: Boolean(json.payg),
        periodEnd: json.stripeCurrentPeriodEnd ?? null,
        cancelAtPeriodEnd: Boolean(json.stripeCancelAtPeriodEnd),
      };
      setWorkspace(next);
      return next;
    } catch {
      // The header falls back to a generic name; the rest of the tab does not depend on it.
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Back from Stripe's cancel flow (`?subscription=canceled`): the webhook usually lands within a
      // second or two, so read fresh and retry briefly until the cancellation shows, then confirm it.
      const params = new URLSearchParams(window.location.search);
      const backFromCancel = params.get("subscription") === "canceled";
      if (backFromCancel) {
        params.delete("subscription");
        const qs = params.toString();
        window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
      }
      let next = await loadWorkspace(backFromCancel);
      for (let i = 0; backFromCancel && !cancelled && next && !next.cancelAtPeriodEnd && i < 6; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        next = await loadWorkspace(true);
      }
      if (backFromCancel && !cancelled) {
        const date = next?.periodEnd ? formatShortDate(next.periodEnd) : "";
        setBillingNotice(
          next?.cancelAtPeriodEnd
            ? `Subscription cancelled. ${next.name ?? "This workspace"} keeps Pro${date ? ` until ${date}` : " until the end of this period"}, then moves to Free.`
            : "Back from Stripe. If you cancelled, it can take a moment to show here; refresh in a few seconds.",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadWorkspace]);


  useEffect(() => {
    // Show debug UI only when DEBUG_LEVEL>0 (injected into window.__DEBUG_LEVEL__ by RootLayout).
    setDebugEnabled(isDebugEnabled(1));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const snap = billingCacheFresh();
    const hasCached = Boolean(snap?.summary);
    setSummaryBusy(!hasCached);
    setSummaryError(null);
    void (async () => {
      try {
        if (hasCached && snap?.summary) {
          if (!cancelled) {
            setSummary(snap.summary);
            setCycleStartIso(snap.summary.cycle?.start ?? null);
          }
          return;
        }
        const res = await fetch("/api/billing/summary", { method: "GET" });
        const json = (await res.json().catch(() => null)) as BillingSummary | { error?: string } | null;
        if (!res.ok) throw new Error((json as any)?.error || `Request failed (${res.status})`);
        if (!json || !(json as any).cycle) throw new Error("Invalid response");
        if (!cancelled) {
          setSummary(json as BillingSummary);
          setCycleStartIso((json as any).cycle?.start ?? null);
        }
        writeBillingCache({ summary: json as BillingSummary });
      } catch (e) {
        if (!cancelled) setSummaryError(e instanceof Error ? e.message : "Failed to load billing summary");
      } finally {
        if (!cancelled) setSummaryBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function loadDebug() {
    if (!cycleStartIso) {
      setDebugError("Billing debug requires a loaded cycleStart.");
      return;
    }
    setDebugBusy(true);
    setDebugError(null);
    setDebugPayload(null);
    setDebugCopyDone(false);
    try {
      const qsUsage = new URLSearchParams();
      qsUsage.set("cycleStart", cycleStartIso);
      qsUsage.set("debug", "1");
      const qsSummary = new URLSearchParams();
      qsSummary.set("debug", "1");

      const [summaryRes, usageRes] = await Promise.all([
        fetch(`/api/billing/summary?${qsSummary.toString()}`, { method: "GET", cache: "no-store" }),
        fetch(`/api/billing/usage?${qsUsage.toString()}`, { method: "GET", cache: "no-store" }),
      ]);
      const summaryJson = await summaryRes.json().catch(() => null);
      const usageJson = await usageRes.json().catch(() => null);
      if (!summaryRes.ok) throw new Error(summaryJson?.error || `Summary debug failed (${summaryRes.status})`);
      if (!usageRes.ok) throw new Error(usageJson?.error || `Usage debug failed (${usageRes.status})`);

      setDebugPayload({
        generatedAtIso: new Date().toISOString(),
        summary: summaryJson?.debug ?? null,
        usage: usageJson?.debug ?? null,
      });
    } catch (e) {
      setDebugError(e instanceof Error ? e.message : "Failed to load debug queries");
    } finally {
      setDebugBusy(false);
    }
  }

  async function copyDebug() {
    try {
      setDebugCopying(true);
      setDebugCopyDone(false);
      await navigator.clipboard.writeText(formatJson(debugPayload));
      setDebugCopyDone(true);
      window.setTimeout(() => setDebugCopyDone(false), 1200);
    } catch (e) {
      setDebugError(e instanceof Error ? e.message : "Copy failed");
    } finally {
      setDebugCopying(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    const start = cycleStartIso;
    if (!start) return;
    const snap = billingCacheFresh();
    const cachedUsage = snap?.usageByCycleStart?.[start] ?? null;
    if (cachedUsage) {
      setUsageError(null);
      setUsageBusy(false);
      setUsage(cachedUsage);
      return;
    }
    setUsageBusy(true);
    setUsageError(null);
    void (async () => {
      try {
        const qs = new URLSearchParams();
        qs.set("cycleStart", start);
        // Pass cycleEnd so the API can avoid extra DB reads (it otherwise needs to infer period length).
        const opt = cycleOptions.find((c) => c.start === start) ?? null;
        const cycleEndIso = opt?.end ?? summary?.cycle?.end ?? "";
        if (cycleEndIso) qs.set("cycleEnd", cycleEndIso);
        const res = await fetch(`/api/billing/usage?${qs.toString()}`, { method: "GET" });
        const json = (await res.json().catch(() => null)) as BillingUsage | { error?: string } | null;
        if (!res.ok) throw new Error((json as any)?.error || `Request failed (${res.status})`);
        if (!json || !(json as any).cycle) throw new Error("Invalid response");
        if (!cancelled) setUsage(json as BillingUsage);
        writeBillingCache({
          usageByCycleStart: { ...(billingCache?.usageByCycleStart ?? {}), [start]: json as BillingUsage },
        });
      } catch (e) {
        if (!cancelled) setUsageError(e instanceof Error ? e.message : "Failed to load billing usage");
        if (!cancelled) setUsage(null);
      } finally {
        if (!cancelled) setUsageBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cycleStartIso, cycleOptions, summary?.cycle?.end]);

  useEffect(() => {
    let cancelled = false;
    /**
     * Invoices are owner/admin only on the server, so a member must not ask for them.
     *
     * The role gate was added to `/api/billing/invoices` to stop a viewer reading the workspace's
     * billing history — correct — but the tab is in the nav for everyone, and this effect fired
     * regardless of role. A member opening Billing got a raw 403 rendered as a failure, which reads
     * as the product being broken rather than as a permission they do not have. The page says so
     * below instead.
     */
    if (!canManageBilling) {
      setInvoicesBusy(false);
      setInvoicesError(null);
      return;
    }
    // Prevent a redundant second request on initial load:
    // first request returns `selectedMonth`, we set it, which re-triggers the effect.
    if (invoices && selectedMonth && invoices.selectedMonth === selectedMonth) return;

    const snap = billingCacheFresh();
    const cacheKey = selectedMonth ? selectedMonth : "__default__";
    const cachedInvoices = snap?.invoicesByMonth?.[cacheKey] ?? null;
    if (cachedInvoices) {
      setInvoicesError(null);
      setInvoicesBusy(false);
      setInvoices(cachedInvoices);
      if (!selectedMonth) setSelectedMonth(cachedInvoices.selectedMonth ?? null);
      return;
    }

    setInvoicesBusy(true);
    setInvoicesError(null);
    void (async () => {
      try {
        const qs = new URLSearchParams();
        if (selectedMonth) qs.set("month", selectedMonth);
        const res = await fetch(`/api/billing/invoices?${qs.toString()}`, { method: "GET" });
        const json = (await res.json().catch(() => null)) as BillingInvoices | { error?: string } | null;
        if (!res.ok) throw new Error((json as any)?.error || `Request failed (${res.status})`);
        if (!json || !Array.isArray((json as any).months)) throw new Error("Invalid response");
        if (!cancelled) {
          setInvoices(json as BillingInvoices);
          if (!selectedMonth) setSelectedMonth((json as any).selectedMonth ?? null);
        }
        const monthKey = typeof (json as any)?.selectedMonth === "string" ? String((json as any).selectedMonth).trim() : "";
        writeBillingCache({
          invoicesByMonth: {
            ...(billingCache?.invoicesByMonth ?? {}),
            [cacheKey]: json as BillingInvoices,
            ...(monthKey ? { [monthKey]: json as BillingInvoices } : null),
          },
        });
      } catch (e) {
        if (!cancelled) setInvoicesError(e instanceof Error ? e.message : "Failed to load invoices");
        if (!cancelled) setInvoices(null);
      } finally {
        if (!cancelled) setInvoicesBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `canManageBilling` is in the deps on purpose: it is `false` while `usePlan()` is still loading
    // on a cold load of this tab, so the early return above fires first, and without it here the
    // effect never re-ran once the plan resolved. Owners who landed straight on Billing saw the
    // skeleton forever; only visiting Overview first (which warms the plan cache) masked it.
  }, [selectedMonth, invoices, canManageBilling]);

  useEffect(() => {
    // Widen (never narrow) the invoice-month floor the period selector is sized from. See
    // `oldestInvoiceMonth` above for why a narrowed `months` list must not shrink the selector.
    const months = (invoices?.months ?? []).filter((m) => typeof m === "string" && /^\d{4}-\d{2}$/.test(m));
    if (!months.length) return;
    const oldest = months.reduce((min, m) => (m < min ? m : min));
    setOldestInvoiceMonth((prev) => (!prev || oldest < prev ? oldest : prev));
  }, [invoices]);

  async function openCancelFlow() {
    setCancelBusy(true);
    setManageError(null);
    setBillingNotice(null);
    try {
      // Same tab: Stripe's cancel flow redirects back here with `?subscription=canceled` when done.
      await openBillingPortal({ flow: "cancel" });
    } catch (e) {
      setManageError(e instanceof Error ? e.message : "Failed to open cancellation");
      setCancelBusy(false);
    }
  }

  async function resumePro() {
    setResumeBusy(true);
    setManageError(null);
    setBillingNotice(null);
    try {
      await resumeSubscription();
      const next = await loadWorkspace(true);
      const date = next?.periodEnd ? formatShortDate(next.periodEnd) : "";
      setBillingNotice(`Pro resumed. ${next?.name ?? "This workspace"} renews${date ? ` on ${date}` : " as normal"}.`);
    } catch (e) {
      setManageError(e instanceof Error ? e.message : "Failed to resume the subscription");
    } finally {
      setResumeBusy(false);
    }
  }

  async function openPortal() {
    setManageBusy(true);
    setManageError(null);
    try {
      // Same tab, so Stripe's "Return to LinkDrop" lands back on this tab instead of leaving a stray tab.
      await openBillingPortal();
    } catch (e) {
      setManageError(e instanceof Error ? e.message : "Failed to open billing portal");
    } finally {
      setManageBusy(false);
    }
  }

  /**
   * The usage payload only counts once it is the SELECTED period's.
   *
   * `usage` keeps the previous period's payload on screen while the next one is fetched, so
   * everything below reads through this guard and renders its loading state instead of dressing
   * one period's numbers in another period's dates.
   */
  const usageForCycle = usage && (!cycleStartIso || sameInstant(usage.cycle?.start, cycleStartIso)) ? usage : null;

  /**
   * The period every figure on this page describes.
   *
   * The dates and the on-demand total used to come from `summary`, which is fetched once with no
   * cycle parameter and is always the CURRENT cycle, while the Period selector re-fetched the
   * tables for the selected one. Picking a past period repainted the rows and the subtotal but
   * left today's dates above them and today's dollar figure on top, with nothing saying so — the
   * headline could read "$47.20" over a table that added up to $6.10. `summary` is now only the
   * fallback for the moment before the selected period's payload lands.
   */
  const displayedCycle = usageForCycle?.cycle ?? cycleOptions.find((c) => sameInstant(c.start, cycleStartIso)) ?? summary?.cycle ?? null;
  const cycleRange = displayedCycle ? formatDateRange(displayedCycle.start, displayedCycle.end) : "";
  const includedRows = usageForCycle?.included?.rows ?? [];
  const includedTotal = usageForCycle?.included?.total ?? null;
  const onDemandRows = usageForCycle?.onDemand?.rows ?? [];
  const onDemandAdjustments = usageForCycle?.onDemand?.adjustments ?? [];
  const onDemandSubtotalCents = clampNonNegInt(usageForCycle?.onDemand?.subtotalCents ?? 0);
  const onDemandHasUnknownCost = onDemandRows.some((r) => r.totalCents === null || r.costCents === null);
  // Per-cycle figures from the per-cycle payload; `summary` is the current cycle's and is only the
  // stand-in while that payload loads.
  const onDemandUsedCents = clampNonNegInt(usageForCycle?.onDemand?.usedCents ?? summary?.onDemand?.usedCentsThisCycle ?? 0);
  const onDemandLimitCents = clampNonNegInt(usageForCycle?.onDemand?.limitCents ?? summary?.onDemand?.monthlyLimitCents ?? 0);
  const onDemandUnlimited = Boolean(summary?.onDemand?.enabled) && onDemandLimitCents >= UNLIMITED_LIMIT_CENTS;
  const onDemandLimitLabel = onDemandUnlimited ? "Unlimited" : formatUsdFromCents(onDemandLimitCents);

  const summaryLoaded = Boolean(summary) && !summaryBusy && !summaryError;
  const usageLoaded = Boolean(usageForCycle) && !usageBusy && !usageError;
  const invoicesLoaded = Boolean(invoices) && !invoicesBusy && !invoicesError;

  return (
    <div className="grid grid-cols-1 gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-[24px] font-semibold tracking-tight text-[var(--fg)]">Billing & Invoices</div>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          {debugEnabled ? (
            <button
              type="button"
              className="rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] font-semibold text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]"
              onClick={() => {
                setDebugOpen(true);
                void loadDebug();
              }}
            >
              Debug queries
            </button>
          ) : null}
        </div>
      </div>

      <BilledWorkspaceHeader
        workspace={workspace}
        isPersonal={Boolean(planSnapshot?.isPersonalOrg)}
        canManageBilling={planSnapshot?.role === "owner" || planSnapshot?.role === "admin"}
        manageBusy={manageBusy}
        onManage={openPortal}
        cancelBusy={cancelBusy}
        onCancel={() => void openCancelFlow()}
        resumeBusy={resumeBusy}
        onResume={() => void resumePro()}
      />

      {billingNotice ? (
        <Alert variant="info" className="text-[12px]">
          {billingNotice}
        </Alert>
      ) : null}

      {manageError ? (
        <Alert variant="error" className="text-[12px]">
          {manageError}
        </Alert>
      ) : null}

      <Modal
        open={debugOpen}
        onClose={() => {
          if (debugBusy) return;
          setDebugOpen(false);
        }}
        ariaLabel="Billing debug queries"
        panelClassName="w-[min(980px,calc(100vw-32px))]"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[18px] font-semibold tracking-tight text-[var(--fg)]">Billing debug queries</div>
            <div className="mt-1 text-[12px] text-[var(--muted-2)]">
              Copy/paste the payload below. The `usage.mongosh` field contains a ready-to-run aggregation.
            </div>
          </div>
          <CopyButton
            copyDone={debugCopyDone}
            isCopying={debugCopying}
            disabled={debugBusy || !debugPayload}
            onCopy={() => void copyDebug()}
            className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-60"
            label="Copy JSON"
          />
        </div>

        {debugBusy ? <div className="mt-4 text-[12px] text-[var(--muted-2)]">Loading…</div> : null}
        {debugError ? (
          <Alert variant="error" className="mt-4 text-[12px]">
            {debugError}
          </Alert>
        ) : null}

        {!debugBusy && !debugError ? (
          <pre className="mt-4 max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3 text-[12px] text-[var(--muted-2)]">
            {formatJson(debugPayload)}
          </pre>
        ) : null}
      </Modal>

      {/* Card 1: Included Usage */}
      <Panel padding="lg">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[13px] font-semibold text-[var(--fg)]">Included usage</div>
            <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">
              {summaryLoaded ? cycleRange : <SkeletonPill widthClassName="w-56" />}
            </div>
            <div className="mt-2 text-[12px] text-[var(--muted-2)]">
              {workspace && workspace.plan !== "pro" ? (
                <>
                  Free workspaces get a one-time grant of starter credits
                  {summaryLoaded ? (
                    <>
                      , and <span className="font-semibold text-[var(--fg)]">{formatInt(summary!.balances.trialRemaining)}</span> are left
                    </>
                  ) : null}
                  . Pro includes {CREDITS_COPY.proPerMonth} credits a month, about{" "}
                  {comparesFor(CREDITS_COPY.proPerMonth)} standard AI compares.
                </>
              ) : (
                `Includes ${CREDITS_COPY.proPerMonth} credits a month, about ${comparesFor(CREDITS_COPY.proPerMonth)} standard AI compares. Credits reset on your renewal date.`
              )}
            </div>
            <button
              type="button"
              className="mt-1 text-[12px] font-semibold text-[var(--fg)] underline underline-offset-2 opacity-80 hover:opacity-100"
              onClick={() => setCreditsInfoOpen((v) => !v)}
            >
              What are credits?
            </button>
          </div>
        </div>

        {summaryError ? (
          <Alert variant="error" className="mt-4 text-[12px]">
            {summaryError}
          </Alert>
        ) : null}

        <div className="mt-4">
          {!summaryLoaded || usageBusy || !usageForCycle ? (
            <SkeletonLines lines={4} />
          ) : usageError ? (
            <Alert variant="error" className="text-[12px]">
              {usageError}
            </Alert>
          ) : usageLoaded && includedRows.length === 0 ? (
            <div className="text-[12px] text-[var(--muted-2)]">No usage yet for this period.</div>
          ) : (
            <DataTable containerClassName="bg-[var(--panel-2)]">
              <thead className="bg-[var(--panel)] text-[12px] font-semibold text-[var(--muted-2)]">
                <tr>
                  <th className="px-4 py-3">Item</th>
                  <th className="px-4 py-3 text-right">Credits</th>
                  <th className="px-4 py-3 text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {includedRows.map((r) => (
                  <tr key={`${r.bucket ?? ""}:${r.label}`} className="border-t border-[var(--border)]">
                    <td className="px-4 py-3 text-[13px] text-[var(--muted-2)]">{ledgerRowLabel(r)}</td>
                    <td className="px-4 py-3 text-right text-[13px] text-[var(--muted-2)]">{formatInt(r.credits)}</td>
                    <td className="px-4 py-3 text-right text-[13px] text-[var(--muted-2)]">
                      {(r.costLabel ?? "").trim() ? r.costLabel : r.costCents === 0 ? "Included" : formatUsdFromCents(r.costCents)}
                    </td>
                  </tr>
                ))}
                {includedTotal ? (
                  <tr className="border-t border-[var(--border)] bg-[var(--panel)]">
                    <td className="px-4 py-3 text-[13px] font-semibold text-[var(--fg)]">Total</td>
                    <td className="px-4 py-3 text-right text-[13px] font-semibold text-[var(--fg)]">{formatInt(includedTotal.credits)}</td>
                    <td className="px-4 py-3 text-right text-[13px] font-semibold text-[var(--fg)]">
                      {(includedTotal.costLabel ?? "").trim()
                        ? includedTotal.costLabel
                        : includedTotal.costCents === 0
                          ? "Included"
                          : formatUsdFromCents(includedTotal.costCents)}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </DataTable>
          )}
        </div>
        {creditsInfoOpen ? <CreditsInfo className="mt-4" /> : null}
      </Panel>

      {/* Card 2: On-Demand Usage */}
      <Panel padding="lg">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-[var(--fg)]">On-demand usage</div>
            <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">
              {summaryLoaded ? cycleRange : <SkeletonPill widthClassName="w-56" />}
            </div>

            <div className="mt-4 text-[26px] font-semibold tracking-tight text-[var(--fg)]">
              {!summaryLoaded ? (
                <SkeletonPill widthClassName="w-48" />
              ) : summary?.onDemand?.enabled && usageLoaded && onDemandHasUnknownCost ? (
                <>
                  <span className="text-[14px] font-semibold text-[var(--muted-2)]">Not available</span>{" "}
                  <span className="text-[14px] font-semibold text-[var(--muted-2)]">
                    / {onDemandLimitLabel}
                  </span>
                </>
              ) : summary?.onDemand?.enabled ? (
                <>
                  {formatUsdFromCents(onDemandUsedCents)}{" "}
                  <span className="text-[14px] font-semibold text-[var(--muted-2)]">
                    / {onDemandLimitLabel}
                  </span>
                </>
              ) : (
                <>
                  {formatUsdFromCents(0)}{" "}
                  <span className="text-[14px] font-semibold text-[var(--muted-2)]">/ {formatUsdFromCents(0)}</span>
                </>
              )}
            </div>
            <div className="mt-1 text-[12px] text-[var(--muted-2)]">
              On-demand charges apply only after included credits are used.
            </div>
            <button
              type="button"
              className="mt-1 text-[12px] font-semibold text-[var(--fg)] underline underline-offset-2 opacity-80 hover:opacity-100"
              onClick={() => setCreditsInfoOpen((v) => !v)}
            >
              What are credits?
            </button>
          </div>

          <div className="shrink-0">
            <div className="text-[12px] font-semibold text-[var(--muted-2)]">Period</div>
            <Select
              className="mt-2"
              value={cycleStartIso ?? ""}
              onChange={(e) => setCycleStartIso(e.target.value)}
              disabled={!summaryLoaded || cycleOptions.length <= 1}
            >
              {cycleOptions.map((c) => (
                <option key={c.start} value={c.start}>
                  {c.label}
                </option>
              ))}
            </Select>
          </div>
        </div>

        {summaryLoaded && summary && !summary.onDemand.enabled ? (
          <div className="mt-4 text-[12px] text-[var(--muted-2)]">On-demand is disabled for this workspace.</div>
        ) : null}

        <div className="mt-4">
          {!summaryLoaded || usageBusy || !usageForCycle ? (
            <SkeletonLines lines={4} />
          ) : usageError ? (
            <Alert variant="error" className="text-[12px]">
              {usageError}
            </Alert>
          ) : summaryLoaded && summary && !summary.onDemand.enabled ? null : usageLoaded && onDemandRows.length === 0 ? (
            <div className="text-[12px] text-[var(--muted-2)]">No usage yet for this period.</div>
          ) : (
            <>
              <DataTable containerClassName="bg-[var(--panel-2)]">
                <thead className="bg-[var(--panel)] text-[12px] font-semibold text-[var(--muted-2)]">
                  <tr>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3 text-right">Credits</th>
                    <th className="px-4 py-3 text-right">Cost</th>
                    <th className="px-4 py-3 text-right">Qty</th>
                    <th className="px-4 py-3 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {onDemandRows.map((r) => (
                    <tr key={`${r.bucket ?? ""}:${r.label}`} className="border-t border-[var(--border)]">
                      <td className="px-4 py-3 text-[13px] text-[var(--muted-2)]">{ledgerRowLabel(r)}</td>
                      <td className="px-4 py-3 text-right text-[13px] text-[var(--muted-2)]">{formatInt(r.credits)}</td>
                      <td className="px-4 py-3 text-right text-[13px] text-[var(--muted-2)]">
                        {formatUsdOrNotAvailable(r.costCents)}
                      </td>
                      <td className="px-4 py-3 text-right text-[13px] text-[var(--muted-2)]">{formatInt(r.qty)}</td>
                      <td className="px-4 py-3 text-right text-[13px] text-[var(--muted-2)]">
                        {formatUsdOrNotAvailable(r.totalCents)}
                      </td>
                    </tr>
                  ))}

                  {onDemandAdjustments.map((a, idx) => (
                    <tr key={`${a.description}-${idx}`} className="border-t border-[var(--border)]">
                      <td className="px-4 py-3 text-[13px] text-[var(--muted-2)]" colSpan={4}>
                        {a.description}
                      </td>
                      <td className="px-4 py-3 text-right text-[13px] text-[var(--muted-2)]">
                        {a.totalCents < 0 ? `-${formatUsdFromCents(Math.abs(a.totalCents))}` : formatUsdFromCents(a.totalCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>

              <div className="mt-3 flex justify-end text-[13px] text-[var(--muted-2)]">
                <div>
                  Subtotal:{" "}
                  <span className="font-semibold text-[var(--fg)]">
                    {onDemandHasUnknownCost
                      ? "Not available"
                      : formatUsdFromCents(onDemandSubtotalCents + onDemandAdjustments.reduce((s, a) => s + a.totalCents, 0))}
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
        {creditsInfoOpen ? <CreditsInfo className="mt-4" /> : null}
      </Panel>

      {/* Card 3: Invoices */}
      <Panel padding="lg">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="text-[13px] font-semibold text-[var(--fg)]">Invoices</div>
            <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">Recent invoices for this workspace.</div>
          </div>
          <div className="shrink-0">
            <div className="text-[12px] font-semibold text-[var(--muted-2)]">Month</div>
            <Select
              className="mt-2"
              value={selectedMonth ?? invoices?.selectedMonth ?? ""}
              onChange={(e) => setSelectedMonth(e.target.value)}
              disabled={!invoicesLoaded || (invoices?.months?.length ?? 0) <= 1}
            >
              {(invoices?.months?.length ?? 0) > 0 ? (
                invoices!.months.map((m) => (
                  <option key={m} value={m}>
                    {formatMonthLabel(m)}
                  </option>
                ))
              ) : (
                <option value={invoices?.selectedMonth ?? ""}>{formatMonthLabel(invoices?.selectedMonth ?? "")}</option>
              )}
            </Select>
          </div>
        </div>

        {!canManageBilling ? (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3 text-sm text-[var(--muted)]">
            Invoices are visible to workspace owners and admins. Ask an owner if you need a copy.
          </div>
        ) : invoicesError ? (
          <Alert variant="error" className="mt-4 text-[12px]">
            {invoicesError}
          </Alert>
        ) : null}

        <div className="mt-4">
          {invoicesBusy || !invoices ? (
            <SkeletonLines lines={4} />
          ) : invoicesLoaded && invoices.invoices.length === 0 ? (
            <div className="text-[12px] text-[var(--muted-2)]">No invoices available.</div>
          ) : (
            <DataTable containerClassName="bg-[var(--panel-2)]">
              <thead className="bg-[var(--panel)] text-[12px] font-semibold text-[var(--muted-2)]">
                <tr>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Description</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3 text-right">Invoice</th>
                </tr>
              </thead>
              <tbody>
                {invoices.invoices.map((inv) => (
                  <tr key={`${inv.date}-${inv.description}`} className="border-t border-[var(--border)]">
                    <td className="whitespace-nowrap px-4 py-3 text-[13px] text-[var(--muted-2)]">{formatShortDate(inv.date)}</td>
                    <td className="px-4 py-3 text-[13px] text-[var(--muted-2)]">{inv.description}</td>
                    <td className="px-4 py-3 text-[13px] text-[var(--muted-2)]">{inv.status ? inv.status.charAt(0).toUpperCase() + inv.status.slice(1) : "–"}</td>
                    <td className="px-4 py-3 text-right text-[13px] text-[var(--muted-2)]">
                      {inv.currency === "USD"
                        ? formatUsdFromCents(inv.amountCents)
                        : `${(clampNonNegInt(inv.amountCents) / 100).toFixed(2)} ${inv.currency}`}
                    </td>
                    <td className="px-4 py-3 text-right text-[13px] text-[var(--muted-2)]">
                      {inv.hostedInvoiceUrl ? (
                        <a className="underline underline-offset-2" href={inv.hostedInvoiceUrl} target="_blank" rel="noreferrer">
                          View
                        </a>
                      ) : (
                        <span className="opacity-70">Not available</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </div>
      </Panel>
    </div>
  );
}


