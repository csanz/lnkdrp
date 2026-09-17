/**
 * Admin route: `/a/credits`
 *
 * Credits across the fleet: anomalies first, then balances ordered by who runs out soonest, then
 * the ledger, purchases and on-demand spend. Picking a workspace scopes the lower panels to it and
 * fills the workspace field the existing write tools use.
 *
 * The read panels never call `getCreditsSnapshot`: it upserts a balance row (seeding the starter
 * grant and the daily cap) as a side effect, which would write to the workspace being inspected.
 * They read the stored rows instead, so a workspace with no balance row simply does not appear.
 */
"use client";

import { signIn, useSession } from "next-auth/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import DataTable from "@/components/ui/DataTable";
import Input from "@/components/ui/Input";
import Panel from "@/components/ui/Panel";
import Select from "@/components/ui/Select";
import { fmtDate } from "@/lib/admin/format";
import {
  bucketSplitLabel,
  creditsShown,
  fmtCents,
  fmtCredits,
  reachablePageCount,
  type AdminCreditAnomalySeverity,
  type AdminCreditBucketSplit,
  type AdminCreditPlan,
} from "@/lib/admin/creditsAdmin";
import { ADMIN_PAGE_CONTAINER } from "@/lib/admin/layout";
import { fetchJson } from "@/lib/http/fetchJson";

type CreditRules = {
  starterGrant: number;
  includedPerCycle: number;
  freeDailyCap: number;
  purchaseExpiryMonths: number;
  usdCentsPerCredit: number;
};

type BalanceRow = {
  workspaceId: string;
  workspaceName: string | null;
  workspaceType: string | null;
  plan: AdminCreditPlan;
  subscriptionStatus: string | null;
  starter: number;
  included: number;
  purchased: number;
  totalRemaining: number;
  dailyCreditCap: number | null;
  onDemandEnabled: boolean;
  onDemandMonthlyLimitCents: number;
  currentPeriodEnd: string | null;
  updatedDate: string | null;
  anomalies: Array<{ code: string; severity: AdminCreditAnomalySeverity; reason: string; detail: string }>;
};

type LedgerRow = {
  id: string;
  workspaceId: string;
  workspaceName: string | null;
  docId: string | null;
  actionType: string | null;
  qualityTier: string | null;
  status: string;
  eventType: string | null;
  source: string | null;
  creditsEstimated: number;
  creditsReserved: number;
  creditsCharged: number;
  split: AdminCreditBucketSplit;
  adminReason: string | null;
  createdDate: string | null;
  stalePending: boolean;
};

type PurchaseRow = {
  id: string;
  workspaceId: string;
  workspaceName: string | null;
  packId: string | null;
  credits: number;
  amountCents: number;
  currency: string | null;
  purchasedAt: string | null;
  expiresAt: string | null;
  expiredAt: string | null;
  creditsExpired: number;
  pastExpiry: boolean;
};

type OnDemandRow = { workspaceId: string; workspaceName: string | null; credits: number; runs: number };

type OnDemandBlock = {
  windowDays: number;
  since: string;
  cycle: { cycleKey: string; onDemandUsedCredits: number; totalUsedCredits: number } | null;
  cycleUnavailableReason: string | null;
  rows: OnDemandRow[];
};

type AnomalyRow = {
  code: string;
  severity: AdminCreditAnomalySeverity;
  reason: string;
  detail: string;
  workspaceId: string;
  workspaceName: string | null;
  plan: AdminCreditPlan | null;
  at: string | null;
};

type AnomalyScan = {
  balanceCandidatesTruncated: boolean;
  proSubscriptionsTruncated: boolean;
  pendingRowsTruncated: boolean;
  overduePurchasesTruncated: boolean;
};

type AdminCreditsSnapshotResponse = {
  ok: true;
  workspaceId: string;
  plan: string;
  stripeSubscriptionId: string | null;
  cycleKey: string | null;
  onDemandLimitCredits: number;
  snapshot: {
    creditsRemaining: number;
    includedRemaining: number;
    paidRemaining: number;
    usedThisCycle: number;
    cycleStart: string | null;
    cycleEnd: string | null;
    includedThisCycle: number | null;
    onDemandEnabled: boolean;
    onDemandMonthlyLimitCents: number;
    onDemandUsedCreditsThisCycle: number;
    onDemandRemainingCreditsThisCycle: number;
    blocked: boolean;
  };
};

type MutateAction = "grant_included" | "grant_on_demand" | "burn";

const BALANCES_PAGE_SIZE = 50;

/** A whole positive number typed into an amount field. */
function isPositiveIntString(v: string): boolean {
  const s = v.trim();
  if (!s) return false;
  const n = Number(s);
  return Number.isFinite(n) && Math.floor(n) === n && n >= 1;
}

/** Keep a mutation amount inside a sane range whatever was typed. */
function clampAmount(n: number): number {
  return Math.max(1, Math.min(1_000_000, Math.floor(n)));
}

/** Rows come off the wire untyped; keep the narrowing in one place. */
function asRows<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** Plan as an admin reads it; `payg` is a Free workspace with a card, not a tier of its own. */
function planLabel(plan: AdminCreditPlan | null): string {
  if (plan === "pro") return "Pro";
  if (plan === "payg") return "Free + card";
  if (plan === "free") return "Free";
  return "—";
}

/** Severity badge for one anomaly. */
function SeverityPill({ severity }: { severity: AdminCreditAnomalySeverity }) {
  const cls =
    severity === "high"
      ? "border-red-300 bg-red-50 text-red-700"
      : "border-amber-300 bg-amber-50 text-amber-800";
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${cls}`}>
      {severity}
    </span>
  );
}

/** The admin credits page. */
export default function AdminCreditsPage() {
  const { data: session, status } = useSession();
  const role = session?.user?.role ?? null;
  const isAuthed = status === "authenticated";
  const isAdmin = isAuthed && role === "admin";
  const isLocalhost =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  const canUseAdmin = isAdmin || isLocalhost;

  const [workspaceId, setWorkspaceId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Anomalies.
  const [anomalies, setAnomalies] = useState<AnomalyRow[]>([]);
  const [anomalyScan, setAnomalyScan] = useState<AnomalyScan | null>(null);
  const [anomaliesLoading, setAnomaliesLoading] = useState(false);
  const [anomaliesError, setAnomaliesError] = useState<string | null>(null);

  // Balances.
  const [balances, setBalances] = useState<BalanceRow[]>([]);
  const [rules, setRules] = useState<CreditRules | null>(null);
  const [balancesTotal, setBalancesTotal] = useState(0);
  // The deep-page ceiling the route enforces. Sizing the pager from `total` alone offered pages
  // past it, and every one of those answered 400 rather than rows.
  const [balancesMaxWindow, setBalancesMaxWindow] = useState(0);
  const [balancesPage, setBalancesPage] = useState(1);
  const [balancesSort, setBalancesSort] = useState<"remaining" | "updated">("remaining");
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [balancesError, setBalancesError] = useState<string | null>(null);

  // Ledger.
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [ledgerEventType, setLedgerEventType] = useState("");
  const [ledgerStatus, setLedgerStatus] = useState("");
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState<string | null>(null);

  // Purchases + on-demand.
  const [purchases, setPurchases] = useState<PurchaseRow[]>([]);
  const [onDemand, setOnDemand] = useState<OnDemandBlock | null>(null);
  const [purchasesLoading, setPurchasesLoading] = useState(false);
  const [purchasesError, setPurchasesError] = useState<string | null>(null);

  // The per-workspace snapshot the write tools act on.
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [data, setData] = useState<AdminCreditsSnapshotResponse | null>(null);

  const [grantIncludedAmount, setGrantIncludedAmount] = useState("300");
  const [grantIncludedReason, setGrantIncludedReason] = useState("");
  const [grantPaidAmount, setGrantPaidAmount] = useState("50");
  const [grantPaidReason, setGrantPaidReason] = useState("");
  const [burnAmount, setBurnAmount] = useState("50");
  const [burnReason, setBurnReason] = useState("");
  const [simStartUnix, setSimStartUnix] = useState("");
  const [simEndUnix, setSimEndUnix] = useState("");
  const [simReason, setSimReason] = useState("");

  const normalizedSnapshot = useMemo(() => data?.snapshot ?? null, [data]);
  const typedWorkspaceId = workspaceId.trim();
  // The ledger and purchases routes answer 400 to a workspaceId that is not an ObjectId, and this
  // field is typed into by hand — scoping on every keystroke put a validation error in both panels
  // for every character of a 24-character id. Scope only once the value is a complete id; until then
  // the panels stay fleet-wide, which is what an empty field already means.
  const scopedWorkspaceId = /^[0-9a-f]{24}$/i.test(typedWorkspaceId) ? typedWorkspaceId : "";
  const balancesTotalPages = useMemo(
    () =>
      reachablePageCount({
        total: balancesTotal || 0,
        pageSize: BALANCES_PAGE_SIZE,
        maxWindow: balancesMaxWindow,
      }),
    [balancesTotal, balancesMaxWindow],
  );

  useEffect(() => {
    if (!canUseAdmin) return;
    setAnomaliesLoading(true);
    setAnomaliesError(null);
    void (async () => {
      try {
        const res = await fetchJson<{ items?: unknown; scanned?: unknown }>("/api/admin/credits/anomalies", {
          method: "GET",
        });
        setAnomalies(asRows<AnomalyRow>(res.items));
        setAnomalyScan((res.scanned ?? null) as AnomalyScan | null);
      } catch (e) {
        setAnomaliesError(e instanceof Error ? e.message : "Failed to load anomalies");
        setAnomalies([]);
        setAnomalyScan(null);
      } finally {
        setAnomaliesLoading(false);
      }
    })();
  }, [canUseAdmin, reloadKey]);

  useEffect(() => {
    if (!canUseAdmin) return;
    setBalancesLoading(true);
    setBalancesError(null);
    const qs = new URLSearchParams({
      limit: String(BALANCES_PAGE_SIZE),
      page: String(balancesPage),
      sort: balancesSort,
    }).toString();
    void (async () => {
      try {
        const res = await fetchJson<{ balances?: unknown; total?: unknown; rules?: unknown; maxWindow?: unknown }>(
          `/api/admin/credits/balances?${qs}`,
          { method: "GET" },
        );
        setBalances(asRows<BalanceRow>(res.balances));
        setBalancesTotal(typeof res.total === "number" ? res.total : Number(res.total ?? 0) || 0);
        setBalancesMaxWindow(typeof res.maxWindow === "number" ? res.maxWindow : 0);
        setRules((res.rules ?? null) as CreditRules | null);
      } catch (e) {
        setBalancesError(e instanceof Error ? e.message : "Failed to load balances");
        setBalances([]);
        setBalancesTotal(0);
      } finally {
        setBalancesLoading(false);
      }
    })();
  }, [canUseAdmin, balancesPage, balancesSort, reloadKey]);

  useEffect(() => {
    if (!canUseAdmin) return;
    setLedgerLoading(true);
    setLedgerError(null);
    const qs = new URLSearchParams({ limit: "50" });
    if (scopedWorkspaceId) qs.set("workspaceId", scopedWorkspaceId);
    if (ledgerEventType) qs.set("eventType", ledgerEventType);
    if (ledgerStatus) qs.set("status", ledgerStatus);
    void (async () => {
      try {
        const res = await fetchJson<{ items?: unknown }>(`/api/admin/credits/ledger?${qs.toString()}`, {
          method: "GET",
        });
        setLedger(asRows<LedgerRow>(res.items));
      } catch (e) {
        setLedgerError(e instanceof Error ? e.message : "Failed to load ledger");
        setLedger([]);
      } finally {
        setLedgerLoading(false);
      }
    })();
  }, [canUseAdmin, scopedWorkspaceId, ledgerEventType, ledgerStatus, reloadKey]);

  useEffect(() => {
    if (!canUseAdmin) return;
    setPurchasesLoading(true);
    setPurchasesError(null);
    const qs = new URLSearchParams({ limit: "25" });
    if (scopedWorkspaceId) qs.set("workspaceId", scopedWorkspaceId);
    void (async () => {
      try {
        const res = await fetchJson<{ purchases?: unknown; onDemand?: unknown }>(
          `/api/admin/credits/purchases?${qs.toString()}`,
          { method: "GET" },
        );
        setPurchases(asRows<PurchaseRow>(res.purchases));
        setOnDemand((res.onDemand ?? null) as OnDemandBlock | null);
      } catch (e) {
        setPurchasesError(e instanceof Error ? e.message : "Failed to load purchases");
        setPurchases([]);
        setOnDemand(null);
      } finally {
        setPurchasesLoading(false);
      }
    })();
  }, [canUseAdmin, scopedWorkspaceId, reloadKey]);

  const loadSnapshot = useCallback(
    async (nextWorkspaceId?: string) => {
      const ws = (nextWorkspaceId ?? workspaceId).trim();
      setSuccess(null);
      setError(null);
      if (!ws) {
        setError("workspaceId is required");
        return;
      }
      setSnapshotLoading(true);
      try {
        const res = await fetchJson<AdminCreditsSnapshotResponse>(
          `/api/admin/credits/snapshot?workspaceId=${encodeURIComponent(ws)}`,
          { method: "GET" },
        );
        setData(res);
      } catch (e) {
        setData(null);
        setError(e instanceof Error ? e.message : "Failed to load snapshot");
      } finally {
        setSnapshotLoading(false);
      }
    },
    [workspaceId],
  );

  /** Run one credit mutation against the scoped workspace, then reload every panel. */
  async function runMutate(action: MutateAction, amountStr: string, reason: string) {
    const ws = workspaceId.trim();
    setSuccess(null);
    setError(null);
    if (!ws) return setError("workspaceId is required");
    if (!reason.trim()) return setError("reason is required");
    if (!isPositiveIntString(amountStr)) return setError("amount must be a positive integer");
    const amount = clampAmount(Number(amountStr));

    if (action === "burn") {
      const ok = window.confirm(`Burn ${amount} credits from workspace ${ws}? This cannot be undone.`);
      if (!ok) return;
    }

    setSnapshotLoading(true);
    try {
      await fetchJson(`/api/admin/credits/mutate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: ws, action, amount, reason: reason.trim() }),
      });
      await loadSnapshot(ws);
      setReloadKey((v) => v + 1);
      setSuccess(
        action === "grant_included"
          ? `Granted ${amount} included credits.`
          : action === "grant_on_demand"
            ? `Granted ${amount} paid credits.`
            : `Burned ${amount} credits.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to mutate credits");
    } finally {
      setSnapshotLoading(false);
    }
  }

  /** Apply a cycle grant with hand-entered period boundaries (no Stripe call). */
  async function runSimulateCycle() {
    const ws = workspaceId.trim();
    setSuccess(null);
    setError(null);
    if (!ws) return setError("workspaceId is required");
    if (!simReason.trim()) return setError("reason is required");
    if (!isPositiveIntString(simStartUnix) || !isPositiveIntString(simEndUnix)) {
      return setError("newPeriodStartUnixSeconds and newPeriodEndUnixSeconds must be valid unix seconds");
    }
    const start = Math.floor(Number(simStartUnix.trim()));
    const end = Math.floor(Number(simEndUnix.trim()));
    if (end <= start) return setError("newPeriodEndUnixSeconds must be > newPeriodStartUnixSeconds");

    const ok = window.confirm(
      `Simulate new billing cycle for ${ws}?\n\nstart=${start}\nend=${end}\n\nThis will reset included credits via a cycle grant.`,
    );
    if (!ok) return;

    setSnapshotLoading(true);
    try {
      const res = await fetchJson<{ ok: true; cycleKey: string; snapshot: unknown }>(`/api/admin/credits/simulate-cycle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: ws,
          newPeriodStartUnixSeconds: start,
          newPeriodEndUnixSeconds: end,
          reason: simReason.trim(),
        }),
      });
      await loadSnapshot(ws);
      setReloadKey((v) => v + 1);
      setSuccess(`Simulated cycle. cycleKey=${res.cycleKey}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to simulate cycle");
    } finally {
      setSnapshotLoading(false);
    }
  }

  /** Point every scoped panel and the tools at one workspace (empty string = the whole fleet). */
  function scopeTo(ws: string) {
    setWorkspaceId(ws);
    setData(null);
    setSuccess(null);
    setError(null);
  }

  if (status === "loading") {
    return <div className="px-6 py-8 text-sm text-[var(--muted)]">Loading…</div>;
  }

  if (!isAuthed && !isLocalhost) {
    return (
      <div className="px-6 py-10">
        <div className="max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Credits</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">You must be signed in to view this page.</p>
          <div className="mt-5">
            <Button
              variant="solid"
              className="bg-[var(--primary-bg)] px-5 py-2.5 text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)]"
              onClick={() => void signIn("google", { callbackUrl: "/a/credits" })}
            >
              Sign in
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!canUseAdmin) {
    return (
      <div className="px-6 py-10">
        <div className="max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Credits</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">You don’t have access to this page.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className={ADMIN_PAGE_CONTAINER}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-[var(--fg)]">Admin / Credits</h1>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Balances, ledger, purchases and on-demand spend across workspaces, with anomalies called out.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              className="bg-[var(--panel-2)]"
              disabled={anomaliesLoading || balancesLoading || ledgerLoading || purchasesLoading}
              onClick={() => setReloadKey((v) => v + 1)}
            >
              {anomaliesLoading || balancesLoading || ledgerLoading || purchasesLoading ? "Loading…" : "Refresh"}
            </Button>
            <Link
              href="/a"
              className="inline-flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm font-semibold text-[var(--fg)] transition hover:bg-[var(--panel-hover)]"
            >
              Admin home
            </Link>
          </div>
        </div>

        {/* The rules the anomaly checks are measured against, read from the live constants. */}
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-[var(--muted-2)]">
          <span>Starter: {rules ? `${fmtCredits(rules.starterGrant)} once, every non-Pro workspace` : "—"}</span>
          <span>Free brake: {rules ? `${fmtCredits(rules.freeDailyCap)}/day` : "—"}</span>
          <span>Pro included: {rules ? `${fmtCredits(rules.includedPerCycle)}/cycle, no rollover` : "—"}</span>
          <span>On-demand: Pro only</span>
          <span>Packs: Free only{rules ? `, expire after ${rules.purchaseExpiryMonths} months` : ""}</span>
          <span>Metered rate: {rules ? fmtCents(rules.usdCentsPerCredit) : "—"}/credit</span>
        </div>

        {error ? (
          <Alert variant="info" className="mt-5 border border-[var(--border)] bg-[var(--panel)] text-sm text-red-700">
            {error}
          </Alert>
        ) : null}
        {success ? (
          <Alert variant="info" className="mt-5 border border-[var(--border)] bg-[var(--panel)] text-sm text-emerald-700">
            {success}
          </Alert>
        ) : null}

        {/* Anomalies */}
        <Panel className="mt-6 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold text-[var(--fg)]">
              Anomalies {anomalies.length ? `(${anomalies.length})` : ""}
            </div>
            <div className="text-xs text-[var(--muted-2)]">
              Rows that contradict the rules above. Each one says why it is suspicious.
            </div>
          </div>
          {anomaliesError ? <div className="mt-4 text-sm text-red-700">{anomaliesError}</div> : null}
          {anomaliesLoading ? (
            <div className="mt-4 text-sm text-[var(--muted)]">Loading…</div>
          ) : anomalies.length === 0 && !anomaliesError ? (
            <div className="mt-3 text-sm text-[var(--muted)]">
              Nothing flagged in the rows scanned. The sweep is bounded, so this is not proof the whole fleet is clean.
            </div>
          ) : (
            <div className="mt-3 grid gap-2">
              {anomalies.map((a, i) => (
                <div
                  key={`${a.workspaceId}:${a.code}:${i}`}
                  className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <SeverityPill severity={a.severity} />
                    <span className="font-mono text-xs text-[var(--fg)]">{a.code}</span>
                    <button
                      type="button"
                      className="text-sm font-semibold text-[var(--fg)] hover:underline"
                      onClick={() => scopeTo(a.workspaceId)}
                    >
                      {a.workspaceName ?? a.workspaceId}
                    </button>
                    <span className="text-xs text-[var(--muted-2)]">{planLabel(a.plan)}</span>
                    <span className="text-xs text-[var(--muted-2)]">{fmtDate(a.at) || "—"}</span>
                  </div>
                  <div className="mt-1 text-sm text-[var(--muted)]">{a.reason}</div>
                  <div className="mt-1 font-mono text-xs text-[var(--muted-2)]">{a.detail}</div>
                </div>
              ))}
            </div>
          )}
          {anomalyScan &&
          (anomalyScan.balanceCandidatesTruncated ||
            anomalyScan.proSubscriptionsTruncated ||
            anomalyScan.pendingRowsTruncated ||
            anomalyScan.overduePurchasesTruncated) ? (
            <div className="mt-3 text-xs text-[var(--muted-2)]">
              One of the passes hit its row cap, so there may be more than is shown here.
            </div>
          ) : null}
        </Panel>

        {/* Balances */}
        <div className="mt-8 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-[var(--fg)]">Balances</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Credits held per workspace, emptiest first. On-demand headroom is not counted as credits held.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              className="w-[220px] max-w-full"
              value={balancesSort}
              onChange={(e) => {
                setBalancesPage(1);
                setBalancesSort(e.target.value === "updated" ? "updated" : "remaining");
              }}
            >
              <option value="remaining">Closest to running out</option>
              <option value="updated">Recently changed</option>
            </Select>
            <div className="text-xs text-[var(--muted-2)]">
              Page {balancesPage} / {balancesTotalPages} • {balancesTotal} total
            </div>
            <Button
              variant="outline"
              className="bg-[var(--panel-2)]"
              disabled={balancesPage <= 1}
              onClick={() => setBalancesPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </Button>
            <Button
              variant="outline"
              className="bg-[var(--panel-2)]"
              disabled={balancesPage >= balancesTotalPages}
              onClick={() => setBalancesPage((p) => Math.min(balancesTotalPages, p + 1))}
            >
              Next
            </Button>
          </div>
        </div>
        {balancesError ? <div className="mt-4 text-sm text-red-700">{balancesError}</div> : null}
        {balancesLoading ? (
          <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
            Loading…
          </div>
        ) : (
          <DataTable containerClassName="mt-4 rounded-xl bg-[var(--panel-2)]">
            <thead className="border-b border-[var(--border)] bg-[var(--panel)]">
              <tr className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                <th className="px-4 py-3">Workspace</th>
                <th className="px-4 py-3">Plan</th>
                <th className="px-4 py-3">Starter</th>
                <th className="px-4 py-3">Included</th>
                <th className="px-4 py-3">Purchased</th>
                <th className="px-4 py-3">Total</th>
                <th className="px-4 py-3">Daily cap</th>
                <th className="px-4 py-3">On-demand</th>
                <th className="px-4 py-3">Flags</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {balances.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-sm text-[var(--muted)]" colSpan={9}>
                    No credit balances. A workspace only gets a balance row once it first needs credits.
                  </td>
                </tr>
              ) : null}
              {balances.map((b) => (
                <tr key={b.workspaceId} className={b.workspaceId === scopedWorkspaceId ? "bg-[var(--panel-hover)]" : ""}>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      className="font-semibold text-[var(--fg)] hover:underline"
                      onClick={() => scopeTo(b.workspaceId)}
                    >
                      {b.workspaceName ?? "Workspace"}
                    </button>
                    <div className="font-mono text-xs text-[var(--muted)]">{b.workspaceId}</div>
                    <div className="text-xs text-[var(--muted-2)]">{b.workspaceType ?? "—"}</div>
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--muted)]">
                    {planLabel(b.plan)}
                    <div className="text-xs text-[var(--muted-2)]">{b.subscriptionStatus ?? "no subscription"}</div>
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--muted)]">{fmtCredits(b.starter)}</td>
                  <td className="px-4 py-3 text-sm text-[var(--muted)]">{fmtCredits(b.included)}</td>
                  <td className="px-4 py-3 text-sm text-[var(--muted)]">{fmtCredits(b.purchased)}</td>
                  <td className="px-4 py-3 text-sm font-semibold text-[var(--fg)]">{fmtCredits(b.totalRemaining)}</td>
                  <td className="px-4 py-3 text-sm text-[var(--muted)]">
                    {b.dailyCreditCap === null ? "none" : fmtCredits(b.dailyCreditCap)}
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--muted)]">
                    {b.onDemandEnabled ? `on • ${fmtCents(b.onDemandMonthlyLimitCents)}` : "off"}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {b.anomalies.length === 0 ? (
                      <span className="text-[var(--muted-2)]">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {b.anomalies.map((a) => (
                          <span
                            key={a.code}
                            title={`${a.reason} (${a.detail})`}
                            className="font-mono text-[11px] text-red-700"
                          >
                            {a.code}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}

        {/* Workspace scope */}
        <Panel className="mt-8 min-w-0">
          <div className="text-sm font-semibold text-[var(--fg)]">Workspace scope</div>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Set a workspace to scope the ledger, purchases and on-demand panels below, and to use the tools at the end.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div className="min-w-[340px] flex-1">
              <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">workspaceId</div>
              <Input
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
                placeholder="Mongo ObjectId (org/workspace) — empty means all workspaces"
                variant="panel2"
                className="mt-1 w-full"
              />
            </div>
            {/* Clears whatever was typed, not just a valid id — a half-typed value has to be clearable. */}
            <Button variant="outline" className="bg-[var(--panel-2)]" onClick={() => scopeTo("")} disabled={!typedWorkspaceId}>
              Clear
            </Button>
            <Button
              variant="solid"
              className="bg-[var(--primary-bg)] text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)]"
              onClick={() => void loadSnapshot()}
              disabled={snapshotLoading}
            >
              Load snapshot
            </Button>
          </div>
          <div className="mt-4 grid gap-1 text-[13px] text-[var(--muted)]">
            <div className="text-xs text-[var(--muted-2)]">
              The snapshot is the customer-facing view. Loading it seeds a balance row if the workspace has none, so it
              is the one read on this page that can write.
            </div>
            <div>
              <span className="font-semibold text-[var(--fg)]">Credits remaining:</span>{" "}
              {normalizedSnapshot ? fmtCredits(normalizedSnapshot.creditsRemaining) : "—"}
            </div>
            <div>
              <span className="font-semibold text-[var(--fg)]">Included / purchased:</span>{" "}
              {normalizedSnapshot
                ? `${fmtCredits(normalizedSnapshot.includedRemaining)} / ${fmtCredits(normalizedSnapshot.paidRemaining)}`
                : "—"}
            </div>
            <div>
              <span className="font-semibold text-[var(--fg)]">Used this cycle:</span>{" "}
              {normalizedSnapshot ? fmtCredits(normalizedSnapshot.usedThisCycle) : "—"}
            </div>
            <div>
              <span className="font-semibold text-[var(--fg)]">Cycle:</span>{" "}
              {normalizedSnapshot
                ? `${fmtDate(normalizedSnapshot.cycleStart) || "—"} → ${fmtDate(normalizedSnapshot.cycleEnd) || "—"}`
                : "—"}
            </div>
            <div>
              <span className="font-semibold text-[var(--fg)]">Plan:</span> {data ? data.plan : "—"}
            </div>
            <div>
              <span className="font-semibold text-[var(--fg)]">On-demand:</span>{" "}
              {normalizedSnapshot
                ? `${normalizedSnapshot.onDemandEnabled ? "enabled" : "disabled"} • limit=${
                    data?.onDemandLimitCredits ?? 0
                  } credits • used=${fmtCredits(normalizedSnapshot.onDemandUsedCreditsThisCycle)}`
                : "—"}
            </div>
            <div>
              <span className="font-semibold text-[var(--fg)]">cycleKey:</span> {data?.cycleKey ?? "—"}
            </div>
          </div>
        </Panel>

        {/* Ledger */}
        <div className="mt-8 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-[var(--fg)]">
              Ledger {scopedWorkspaceId ? "(this workspace)" : "(all workspaces)"}
            </h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              The 50 most recent rows. The headline credits figure is whichever of charged, reserved or
              estimated the row actually has — a pending row holds reserved credits and has been charged
              nothing yet — with all three shown beneath it.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              className="w-[200px] max-w-full"
              value={ledgerEventType}
              onChange={(e) => setLedgerEventType(e.target.value)}
            >
              <option value="">All events</option>
              <option value="ai_run">AI runs</option>
              <option value="cycle_grant_included">Cycle grants</option>
              <option value="credit_pack_purchase">Pack purchases</option>
              <option value="credit_pack_expired">Pack expiries</option>
              <option value="free_floor_grant">Free floor (historic)</option>
            </Select>
            <Select className="w-[170px] max-w-full" value={ledgerStatus} onChange={(e) => setLedgerStatus(e.target.value)}>
              <option value="">Any status</option>
              <option value="pending">Pending</option>
              <option value="charged">Charged</option>
              <option value="refunded">Refunded</option>
              <option value="failed">Failed</option>
            </Select>
          </div>
        </div>
        {ledgerError ? <div className="mt-4 text-sm text-red-700">{ledgerError}</div> : null}
        {ledgerLoading ? (
          <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
            Loading…
          </div>
        ) : (
          <DataTable containerClassName="mt-4 rounded-xl bg-[var(--panel-2)]">
            <thead className="border-b border-[var(--border)] bg-[var(--panel)]">
              <tr className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3">Workspace</th>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">Tier</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Event</th>
                <th className="px-4 py-3">Credits</th>
                <th className="px-4 py-3">Bucket</th>
                <th className="px-4 py-3">Source</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {ledger.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-sm text-[var(--muted)]" colSpan={9}>
                    No ledger rows for this filter.
                  </td>
                </tr>
              ) : null}
              {ledger.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-3 text-sm text-[var(--muted)]">{fmtDate(r.createdDate) || "—"}</td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      className="text-sm font-semibold text-[var(--fg)] hover:underline"
                      onClick={() => scopeTo(r.workspaceId)}
                    >
                      {r.workspaceName ?? r.workspaceId}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--muted)]">{r.actionType ?? "—"}</td>
                  <td className="px-4 py-3 text-sm text-[var(--muted)]">{r.qualityTier ?? "—"}</td>
                  <td className="px-4 py-3 text-sm text-[var(--muted)]">
                    {r.status}
                    {r.stalePending ? <div className="text-xs font-semibold text-red-700">stale</div> : null}
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--muted)]">{r.eventType ?? "—"}</td>
                  <td className="px-4 py-3 text-sm text-[var(--muted)]">
                    <span className="font-semibold text-[var(--fg)]">{fmtCredits(creditsShown(r).value)}</span>
                    <span className="text-xs text-[var(--muted-2)]"> {creditsShown(r).basis}</span>
                    <div className="text-xs text-[var(--muted-2)]">
                      est {fmtCredits(r.creditsEstimated)}, res {fmtCredits(r.creditsReserved)}, chg{" "}
                      {fmtCredits(r.creditsCharged)}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--muted)]">{bucketSplitLabel(r.split)}</td>
                  <td className="px-4 py-3 text-sm text-[var(--muted)]">
                    {r.source ?? "—"}
                    {r.adminReason ? (
                      <div className="text-xs text-[var(--muted-2)]" title={r.adminReason}>
                        admin
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}

        {/* Purchases + on-demand */}
        <div className="mt-8">
          <h2 className="text-base font-semibold text-[var(--fg)]">
            Purchases and on-demand {scopedWorkspaceId ? "(this workspace)" : "(all workspaces)"}
          </h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Packs are Free-only at purchase time; a workspace keeps them after upgrading, so a live pack on Pro is
            normal.
          </p>
        </div>
        {purchasesError ? <div className="mt-4 text-sm text-red-700">{purchasesError}</div> : null}
        {purchasesLoading ? (
          <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
            Loading…
          </div>
        ) : (
          <>
            <DataTable containerClassName="mt-4 rounded-xl bg-[var(--panel-2)]">
              <thead className="border-b border-[var(--border)] bg-[var(--panel)]">
                <tr className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                  <th className="px-4 py-3">Purchased</th>
                  <th className="px-4 py-3">Workspace</th>
                  <th className="px-4 py-3">Pack</th>
                  <th className="px-4 py-3">Credits</th>
                  <th className="px-4 py-3">Amount</th>
                  <th className="px-4 py-3">Expires</th>
                  <th className="px-4 py-3">State</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {purchases.length === 0 ? (
                  <tr>
                    <td className="px-4 py-6 text-sm text-[var(--muted)]" colSpan={7}>
                      No credit pack purchases.
                    </td>
                  </tr>
                ) : null}
                {purchases.map((p) => (
                  <tr key={p.id}>
                    <td className="px-4 py-3 text-sm text-[var(--muted)]">{fmtDate(p.purchasedAt) || "—"}</td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        className="text-sm font-semibold text-[var(--fg)] hover:underline"
                        onClick={() => scopeTo(p.workspaceId)}
                      >
                        {p.workspaceName ?? p.workspaceId}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-sm text-[var(--muted)]">{p.packId ?? "—"}</td>
                    <td className="px-4 py-3 text-sm text-[var(--muted)]">{fmtCredits(p.credits)}</td>
                    <td className="px-4 py-3 text-sm text-[var(--muted)]">
                      {fmtCents(p.amountCents)}
                      <span className="text-xs text-[var(--muted-2)]"> {p.currency?.toUpperCase() ?? ""}</span>
                    </td>
                    <td className="px-4 py-3 text-sm text-[var(--muted)]">{fmtDate(p.expiresAt) || "—"}</td>
                    <td className="px-4 py-3 text-sm text-[var(--muted)]">
                      {p.expiredAt ? (
                        `expired • ${fmtCredits(p.creditsExpired)} taken back`
                      ) : p.pastExpiry ? (
                        <span className="font-semibold text-red-700">past expiry, not reclaimed</span>
                      ) : (
                        "live"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>

            <Panel className="mt-4 min-w-0">
              <div className="text-sm font-semibold text-[var(--fg)]">On-demand spend</div>
              <div className="mt-1 text-xs text-[var(--muted-2)]">
                {onDemand
                  ? scopedWorkspaceId
                    ? onDemand.cycle
                      ? `This cycle (${onDemand.cycle.cycleKey}): ${fmtCredits(
                          onDemand.cycle.onDemandUsedCredits,
                        )} on-demand of ${fmtCredits(onDemand.cycle.totalUsedCredits)} credits used.`
                      : `No cycle total — ${onDemand.cycleUnavailableReason ?? "unavailable"}.`
                    : `Billing cycles start on a different day per workspace, so this is a rolling ${onDemand.windowDays}-day window rather than one cycle.`
                  : "—"}
              </div>
              <DataTable containerClassName="mt-3 rounded-xl bg-[var(--panel-2)]">
                <thead className="border-b border-[var(--border)] bg-[var(--panel)]">
                  <tr className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                    <th className="px-4 py-3">Workspace</th>
                    <th className="px-4 py-3">On-demand credits</th>
                    <th className="px-4 py-3">Runs</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {!onDemand || onDemand.rows.length === 0 ? (
                    <tr>
                      <td className="px-4 py-6 text-sm text-[var(--muted)]" colSpan={3}>
                        No on-demand credits billed in this window.
                      </td>
                    </tr>
                  ) : null}
                  {(onDemand?.rows ?? []).map((r) => (
                    <tr key={r.workspaceId}>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          className="text-sm font-semibold text-[var(--fg)] hover:underline"
                          onClick={() => scopeTo(r.workspaceId)}
                        >
                          {r.workspaceName ?? r.workspaceId}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-sm text-[var(--muted)]">
                        {fmtCredits(r.credits)}
                        {rules ? (
                          <span className="text-xs text-[var(--muted-2)]">
                            {" "}
                            ≈ {fmtCents(r.credits * rules.usdCentsPerCredit)}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-sm text-[var(--muted)]">{fmtCredits(r.runs)}</td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            </Panel>
          </>
        )}

        {/* Write tools, kept from the original page */}
        <Panel className="mt-8 min-w-0">
          <div className="text-sm font-semibold text-[var(--fg)]">Tools (these write)</div>
          <div className="mt-1 text-xs text-[var(--muted-2)]">
            Everything above is read-only. These act on the workspace in the scope field.
          </div>
          <div className="mt-3 grid gap-5">
            <div className="grid gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-4">
              <div className="text-sm font-semibold text-[var(--fg)]">Grant included credits</div>
              <div className="grid gap-3 md:grid-cols-[220px_1fr_auto]">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Amount</div>
                  <Input value={grantIncludedAmount} onChange={(e) => setGrantIncludedAmount(e.target.value)} variant="panel2" className="mt-1 w-full" />
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Reason (required)</div>
                  <Input value={grantIncludedReason} onChange={(e) => setGrantIncludedReason(e.target.value)} variant="panel2" className="mt-1 w-full" />
                </div>
                <div className="flex items-end">
                  <Button
                    variant="solid"
                    className="bg-[var(--primary-bg)] text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)]"
                    onClick={() => void runMutate("grant_included", grantIncludedAmount, grantIncludedReason)}
                    disabled={snapshotLoading}
                  >
                    Grant
                  </Button>
                </div>
              </div>
            </div>

            <div className="grid gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-4">
              <div className="text-sm font-semibold text-[var(--fg)]">Grant on-demand credits</div>
              <div className="grid gap-3 md:grid-cols-[220px_1fr_auto]">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Amount</div>
                  <Input value={grantPaidAmount} onChange={(e) => setGrantPaidAmount(e.target.value)} variant="panel2" className="mt-1 w-full" />
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Reason (required)</div>
                  <Input value={grantPaidReason} onChange={(e) => setGrantPaidReason(e.target.value)} variant="panel2" className="mt-1 w-full" />
                </div>
                <div className="flex items-end">
                  <Button
                    variant="solid"
                    className="bg-[var(--primary-bg)] text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)]"
                    onClick={() => void runMutate("grant_on_demand", grantPaidAmount, grantPaidReason)}
                    disabled={snapshotLoading}
                  >
                    Grant
                  </Button>
                </div>
              </div>
              <div className="text-xs text-[var(--muted-2)]">Note: This adds to the purchased (non-expiring) credit bucket.</div>
            </div>

            <div className="grid gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-4">
              <div className="text-sm font-semibold text-[var(--fg)]">Burn credits</div>
              <div className="grid gap-3 md:grid-cols-[220px_1fr_auto]">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Amount</div>
                  <Input value={burnAmount} onChange={(e) => setBurnAmount(e.target.value)} variant="panel2" className="mt-1 w-full" />
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Reason (required)</div>
                  <Input value={burnReason} onChange={(e) => setBurnReason(e.target.value)} variant="panel2" className="mt-1 w-full" />
                </div>
                <div className="flex items-end">
                  <Button variant="secondary" onClick={() => void runMutate("burn", burnAmount, burnReason)} disabled={snapshotLoading}>
                    Burn…
                  </Button>
                </div>
              </div>
            </div>

            <div className="grid gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-4">
              <div className="text-sm font-semibold text-[var(--fg)]">Simulate new billing cycle</div>
              <div className="grid gap-3 md:grid-cols-[220px_220px_1fr_auto]">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">newPeriodStartUnixSeconds</div>
                  <Input value={simStartUnix} onChange={(e) => setSimStartUnix(e.target.value)} variant="panel2" className="mt-1 w-full" />
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">newPeriodEndUnixSeconds</div>
                  <Input value={simEndUnix} onChange={(e) => setSimEndUnix(e.target.value)} variant="panel2" className="mt-1 w-full" />
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Reason (required)</div>
                  <Input value={simReason} onChange={(e) => setSimReason(e.target.value)} variant="panel2" className="mt-1 w-full" />
                </div>
                <div className="flex items-end">
                  <Button variant="secondary" onClick={() => void runSimulateCycle()} disabled={snapshotLoading}>
                    Simulate…
                  </Button>
                </div>
              </div>
              <div className="text-xs text-[var(--muted-2)]">Does not call Stripe. Updates stored period boundaries and applies a cycle grant idempotently.</div>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
