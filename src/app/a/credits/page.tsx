/**
 * Admin route: `/a/credits`
 *
 * Credits across the fleet, in one reading order: what is wrong, who is nearly empty, what has
 * been spent, what was bought, and — last, behind its own heading — the four buttons that write.
 * Picking a workspace anywhere scopes the lower sections to it and fills the field the tools use.
 *
 * The read panels never call `getCreditsSnapshot`: it upserts a balance row (seeding the starter
 * grant and the daily cap) as a side effect, which would write to the workspace being inspected.
 * They read the stored rows instead, so a workspace with no balance row simply does not appear.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Panel from "@/components/ui/Panel";
import {
  AdminAlert,
  AdminAccessState,
  AdminFilterBar,
  AdminPageHeader,
  AdminSearchInput,
  AdminSelect,
  AdminTable,
  AdminTableEmpty,
  AdminTableMessage,
  AdminTd,
  AdminTh,
  AdminTr,
  IdCell,
  RowAction,
  RowActions,
  StatusPill,
  TimeCell,
  useAdminAccess,
} from "@/components/admin";
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
import {
  ADMIN_DASH,
  ADMIN_FIELD_LABEL,
  ADMIN_FIELD_VALUE,
  ADMIN_NOTE,
  ADMIN_SECTION_DESC,
  ADMIN_SECTION_GAP,
  ADMIN_SECTION_TITLE,
  type AdminTone,
  ADMIN_NOTE_PANEL,
  ADMIN_SUBBAR,
  statusLabel,
  toneStyle,
} from "@/lib/admin/ui";
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
  /** Only `stale_pending` carries one: the single row that can be put right from here. */
  ledgerId?: string | null;
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
const ANOMALY_COLUMNS = 7;
const BALANCE_COLUMNS = 12;
const LEDGER_COLUMNS = 10;
const PURCHASE_COLUMNS = 8;
const ON_DEMAND_COLUMNS = 4;

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
  return ADMIN_DASH;
}

/** Pro is the paid tier, `payg` is a Free workspace with a card on file, Free is the norm. */
function planTone(plan: AdminCreditPlan | null): AdminTone {
  if (plan === "pro") return "info";
  if (plan === "payg") return "neutral";
  return "quiet";
}

/** A ledger row's state: charged is the norm, failed is the one to see. */
function ledgerTone(status: string): AdminTone {
  if (status === "failed") return "danger";
  if (status === "refunded") return "warning";
  if (status === "pending") return "neutral";
  return "quiet";
}

/** One labelled figure in the snapshot panel. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className={ADMIN_FIELD_LABEL}>{label}</dt>
      <dd className={`mt-0.5 truncate ${ADMIN_FIELD_VALUE}`}>{children}</dd>
    </div>
  );
}

/** The admin credits page. */
export default function AdminCreditsPage() {
  const access = useAdminAccess();
  const canUseAdmin = access.canUseAdmin;

  const [workspaceId, setWorkspaceId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Anomalies.
  const [anomalies, setAnomalies] = useState<AnomalyRow[]>([]);
  const [anomalyScan, setAnomalyScan] = useState<AnomalyScan | null>(null);
  const [anomaliesLoading, setAnomaliesLoading] = useState(false);
  const [anomaliesError, setAnomaliesError] = useState<string | null>(null);
  /** The row whose Release is in flight, so only that button reads as busy. */
  const [releasingLedgerId, setReleasingLedgerId] = useState<string | null>(null);

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
  const anyLoading = anomaliesLoading || balancesLoading || ledgerLoading || purchasesLoading;
  const balancesTotalPages = useMemo(
    () =>
      reachablePageCount({
        total: balancesTotal || 0,
        pageSize: BALANCES_PAGE_SIZE,
        maxWindow: balancesMaxWindow,
      }),
    [balancesTotal, balancesMaxWindow],
  );
  // The band sizes its pager from the total it is given, so hand it the reachable total — otherwise
  // Next stays enabled past the window the route will serve and every click there answers 400.
  const balancesReachableTotal = Math.min(balancesTotal, balancesTotalPages * BALANCES_PAGE_SIZE);

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

  /**
   * Give back one stale reservation's credits.
   *
   * The hourly sweeper does this on its own; this is for when an operator is already looking at
   * the row. Both go through the same transactional refund, which does nothing to a row that has
   * settled in the meantime, so a double press cannot refund twice. The list is reloaded rather
   * than patched in place: whatever the row's new state is, it should come from the server.
   */
  async function releaseReservation(ledgerId: string) {
    setReleasingLedgerId(ledgerId);
    setAnomaliesError(null);
    try {
      const res = await fetchJson<{ released?: unknown; creditsReturned?: unknown }>("/api/admin/credits/release", {
        method: "POST",
        body: JSON.stringify({ ledgerId }),
      });
      setSuccess(
        res.released
          ? `Released ${Number(res.creditsReturned) || 0} credits back to the workspace.`
          : "That reservation had already settled; nothing was returned.",
      );
      setReloadKey((k) => k + 1);
    } catch (e) {
      setAnomaliesError(e instanceof Error ? e.message : "Failed to release that reservation");
    } finally {
      setReleasingLedgerId(null);
    }
  }

  /** Point every scoped panel and the tools at one workspace (empty string = the whole fleet). */
  function scopeTo(ws: string) {
    setWorkspaceId(ws);
    setData(null);
    setSuccess(null);
    setError(null);
  }

  if (!canUseAdmin) {
    return <AdminAccessState access={access} title="Credits" description="Anomalies first, then who is nearly empty, what was spent, and what was bought." callbackUrl="/a/credits" />;
  }

  const scopeSuffix = scopedWorkspaceId ? "this workspace" : "all workspaces";

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className={ADMIN_PAGE_CONTAINER}>
        <AdminPageHeader
          title="Credits"
          description="Anomalies first, then who is nearly empty, what was spent, and what was bought."
        />

        {/* The one control the whole page hangs off: everything below is scoped by it. */}
        {/* The one control the whole page hangs off, and the only full-width band on it:
            everything below is scoped by this field. Sub-tables carry their own controls
            inline, so a reader can tell page scope from table scope. */}
        <AdminFilterBar
          className="mt-4"
          actions={
            <>
              <RowAction onClick={() => scopeTo("")} disabled={!typedWorkspaceId} title="Back to every workspace">
                Clear scope
              </RowAction>
              <RowAction onClick={() => void loadSnapshot()} disabled={snapshotLoading} title="Read the customer-facing snapshot">
                Load snapshot
              </RowAction>
              <Button variant="outline" disabled={anyLoading} onClick={() => setReloadKey((v) => v + 1)}>
                {anyLoading ? "Loading…" : "Refresh"}
              </Button>
            </>
          }
        >
          <AdminSearchInput
            value={workspaceId}
            onValueChange={setWorkspaceId}
            placeholder="Scope to a workspaceId…"
            ariaLabel="Scope every panel to one workspace id"
          />
          {/* Only the *exception* is worth a sentence in the band; "showing all workspaces"
              is what an empty scope field already says. */}
          {scopedWorkspaceId ? (
            <span className="text-[12px] leading-5 text-[var(--muted-2)]">
              Ledger, purchases and the tools act on this workspace.
            </span>
          ) : typedWorkspaceId ? (
            <span className="text-[12px] leading-5 text-[var(--muted-2)]">
              Not a complete ObjectId yet — still showing all workspaces.
            </span>
          ) : null}
        </AdminFilterBar>

        {/* The rules every anomaly check is measured against, read from the live constants.
            A labelled grid inside a panel: as loose text between two panels it read as
            leftover copy rather than the reference it is. */}
        <div className={`mt-3 ${ADMIN_NOTE_PANEL}`}>
          <dl className="grid grid-cols-2 gap-x-5 gap-y-2 sm:grid-cols-3 xl:grid-cols-6">
            <Fact label="Starter">
              {rules ? `${fmtCredits(rules.starterGrant)} once, non-Pro` : ADMIN_DASH}
            </Fact>
            <Fact label="Free brake">{rules ? `${fmtCredits(rules.freeDailyCap)}/day` : ADMIN_DASH}</Fact>
            <Fact label="Pro included">
              {rules ? `${fmtCredits(rules.includedPerCycle)}/cycle` : ADMIN_DASH}
            </Fact>
            <Fact label="On-demand">Pro only</Fact>
            <Fact label="Packs">
              {rules ? `Free only, ${rules.purchaseExpiryMonths}-month expiry` : "Free only"}
            </Fact>
            <Fact label="Metered rate">
              {rules ? `${fmtCents(rules.usdCentsPerCredit)}/credit` : ADMIN_DASH}
            </Fact>
          </dl>
        </div>

        {error ? (
          <AdminAlert className="mt-3">
            {error}
          </AdminAlert>
        ) : null}
        {success ? (
          <AdminAlert tone="positive" className="mt-3">
            {success}
          </AdminAlert>
        ) : null}

        {normalizedSnapshot ? (
          <Panel padding="md" rounded="xl" className="mt-3 min-w-0">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <div className="text-[13px] font-semibold leading-5 text-[var(--fg)]">Snapshot for this workspace</div>
              <div className="text-[12px] leading-5 text-[var(--muted-2)]">
                The customer-facing view. Reading it seeds a balance row — the one read on this page that writes.
              </div>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
              <Fact label="Remaining">
                <span className="tabular-nums">{fmtCredits(normalizedSnapshot.creditsRemaining)}</span>
              </Fact>
              <Fact label="Included / purchased">
                <span className="tabular-nums">
                  {fmtCredits(normalizedSnapshot.includedRemaining)} / {fmtCredits(normalizedSnapshot.paidRemaining)}
                </span>
              </Fact>
              <Fact label="Used this cycle">
                <span className="tabular-nums">{fmtCredits(normalizedSnapshot.usedThisCycle)}</span>
              </Fact>
              <Fact label="Plan">{data ? data.plan : ADMIN_DASH}</Fact>
              <Fact label="Cycle start">
                <TimeCell value={normalizedSnapshot.cycleStart} mode="date" />
              </Fact>
              <Fact label="Cycle end">
                <TimeCell value={normalizedSnapshot.cycleEnd} mode="date" />
              </Fact>
              <Fact label="On-demand">
                {normalizedSnapshot.onDemandEnabled
                  ? `on • limit ${data?.onDemandLimitCredits ?? 0} • used ${fmtCredits(
                      normalizedSnapshot.onDemandUsedCreditsThisCycle,
                    )}`
                  : "off"}
              </Fact>
              <Fact label="Cycle key">
                <span className="font-mono text-[12px]" title={data?.cycleKey ?? undefined}>
                  {data?.cycleKey ?? ADMIN_DASH}
                </span>
              </Fact>
            </dl>
          </Panel>
        ) : null}

        {/* ---------------------------------------------------------- anomalies */}
        <h2 className={`${ADMIN_SECTION_GAP} ${ADMIN_SECTION_TITLE}`}>
          Anomalies{anomalies.length ? ` (${anomalies.length})` : ""}
        </h2>
        <p className={ADMIN_SECTION_DESC}>Rows that contradict the rules above. Each one says why it is suspicious.</p>

        {anomaliesError ? (
          <AdminAlert className="mt-3">
            {anomaliesError}
          </AdminAlert>
        ) : null}

        <AdminTable
          className="mt-3"
          ariaLabel="Credit anomalies"
          head={
            <>
              {/* Why is the point of the row, so it takes the remaining width; the raw
                  detail rides in its tooltip rather than truncating beside it, because two
                  half-sentences explain nothing. */}
              <AdminTh width="w-[74px]">Severity</AdminTh>
              <AdminTh width="w-[150px]">Workspace</AdminTh>
              <AdminTh width="w-[64px]">Plan</AdminTh>
              <AdminTh width="w-[150px]">Code</AdminTh>
              <AdminTh width="w-full">Why</AdminTh>
              <AdminTh align="right" width="w-[112px]">Seen</AdminTh>
              <AdminTh align="right" sticky>
                Actions
              </AdminTh>
            </>
          }
        >
          {anomaliesLoading && anomalies.length === 0 ? (
            <AdminTableMessage colSpan={ANOMALY_COLUMNS}>Scanning for anomalies…</AdminTableMessage>
          ) : anomalies.length === 0 ? (
            <AdminTableEmpty
              colSpan={ANOMALY_COLUMNS}
              title="Nothing flagged in the rows scanned"
              hint="The sweep is bounded, so this is not proof the whole fleet is clean."
            />
          ) : (
            anomalies.map((a, i) => (
              <AdminTr key={`${a.workspaceId}:${a.code}:${i}`}>
                <AdminTd>
                  <StatusPill tone={a.severity === "high" ? "danger" : "warning"}>{a.severity}</StatusPill>
                </AdminTd>
                <AdminTd primary truncate="max-w-[150px]">
                  <span title={a.workspaceName ?? a.workspaceId}>{a.workspaceName ?? a.workspaceId}</span>
                </AdminTd>
                <AdminTd>{planLabel(a.plan)}</AdminTd>
                <AdminTd mono truncate="max-w-[150px]">
                  <span title={a.code}>{a.code}</span>
                </AdminTd>
                {/* `w-full` + `max-w-0` is what lets the explanation own every pixel the other
                    columns do not need: the cell contributes nothing to the table's intrinsic
                    width, so it fills the slack instead of forcing a scrollbar. */}
                <AdminTd truncate="w-full max-w-0">
                  <span title={[a.reason, a.detail].filter(Boolean).join(" — ")}>{a.reason}</span>
                </AdminTd>
                <AdminTd align="right" numeric>
                  <TimeCell value={a.at} />
                </AdminTd>
                <AdminTd align="right" sticky actions>
                  <RowActions>
                    {a.code === "stale_pending" && a.ledgerId ? (
                      <RowAction
                        onClick={() => void releaseReservation(a.ledgerId!)}
                        disabled={releasingLedgerId !== null}
                        title="Give these credits back now, rather than waiting for the hourly sweep"
                      >
                        {releasingLedgerId === a.ledgerId ? "Releasing…" : "Release"}
                      </RowAction>
                    ) : null}
                    <RowAction onClick={() => scopeTo(a.workspaceId)} title="Scope this page to that workspace">
                      Scope
                    </RowAction>
                  </RowActions>
                </AdminTd>
              </AdminTr>
            ))
          )}
        </AdminTable>

        {anomalyScan &&
        (anomalyScan.balanceCandidatesTruncated ||
          anomalyScan.proSubscriptionsTruncated ||
          anomalyScan.pendingRowsTruncated ||
          anomalyScan.overduePurchasesTruncated) ? (
          <p className={ADMIN_NOTE}>One of the passes hit its row cap, so there may be more than is shown here.</p>
        ) : null}

        {/* ----------------------------------------------------------- balances */}
        <h2 className={`${ADMIN_SECTION_GAP} ${ADMIN_SECTION_TITLE}`}>Balances</h2>
        <p className={ADMIN_SECTION_DESC}>
          Credits held per workspace, emptiest first. On-demand headroom is not credits held.
        </p>

        <AdminFilterBar
          className="mt-3 border-0 bg-transparent px-0"
          page={balancesPage}
          pageSize={BALANCES_PAGE_SIZE}
          total={balancesReachableTotal}
          onPageChange={setBalancesPage}
          noun="workspaces"
          loading={balancesLoading}
        >
          <AdminSelect
            ariaLabel="Sort balances"
            value={balancesSort}
            onChange={(e) => {
              setBalancesPage(1);
              setBalancesSort(e.target.value === "updated" ? "updated" : "remaining");
            }}
          >
            <option value="remaining">Closest to running out</option>
            <option value="updated">Recently changed</option>
          </AdminSelect>
        </AdminFilterBar>

        {balancesError ? (
          <AdminAlert className="mt-3">
            {balancesError}
          </AdminAlert>
        ) : null}

        <AdminTable
          className="mt-3"
          ariaLabel="Credit balances"
          head={
            <>
              <AdminTh width="w-full">Workspace</AdminTh>
              <AdminTh width="w-[70px]">Plan</AdminTh>
              {/* Two headers were wider than any value beneath them and between them they put
                  this table 46px past the container, which pushed the id column under the
                  sticky Actions cell until its own header read "WORKSPACI". Shorter words are
                  the first fix in the width budget, and both are the page's own vocabulary:
                  the rules strip says "Packs", the workspace hub says "Stripe status". */}
              <AdminTh width="w-[86px]" title="Stripe subscription status">
                Status
              </AdminTh>
              <AdminTh align="right">Starter</AdminTh>
              <AdminTh align="right">Included</AdminTh>
              <AdminTh align="right" title="Purchased (pack) credits remaining">
                Packs
              </AdminTh>
              <AdminTh align="right">Total</AdminTh>
              <AdminTh align="right">Daily cap</AdminTh>
              <AdminTh>On-demand</AdminTh>
              <AdminTh>Flags</AdminTh>
              {/* `min-w` not `w`: at twelve columns this table is past the width budget and
                  scrolls, and a plain width let the browser squeeze the last data column until
                  its own header read "WORKSPACI". */}
              <AdminTh width="min-w-[128px]">Workspace ID</AdminTh>
              <AdminTh align="right" sticky>
                Actions
              </AdminTh>
            </>
          }
        >
          {balancesLoading && balances.length === 0 ? (
            <AdminTableMessage colSpan={BALANCE_COLUMNS}>Loading balances…</AdminTableMessage>
          ) : balances.length === 0 ? (
            <AdminTableEmpty
              colSpan={BALANCE_COLUMNS}
              title="No credit balances"
              hint="A workspace only gets a balance row once it first needs credits."
            />
          ) : (
            balances.map((b) => {
              const scoped = b.workspaceId === scopedWorkspaceId;
              const flagTitle = b.anomalies.map((a) => `${a.code}: ${a.reason} (${a.detail})`).join("\n");
              // A "personal" pill beside a workspace called Personal says nothing twice.
              const showType =
                Boolean(b.workspaceType) &&
                b.workspaceType?.toLowerCase() !== (b.workspaceName ?? "").toLowerCase();
              return (
                <AdminTr key={b.workspaceId} className={scoped ? "bg-[var(--panel-hover)]" : undefined}>
                  <AdminTd primary truncate="max-w-[220px]">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="truncate" title={b.workspaceName ?? "Workspace"}>
                        {b.workspaceName ?? "Workspace"}
                      </span>
                      {showType ? <StatusPill tone="quiet" className="shrink-0">{b.workspaceType}</StatusPill> : null}
                    </span>
                  </AdminTd>
                  {/* "Free free" and "Pro active" read as one value said twice. The pill is
                      the plan; the subscription state is a different fact, so a different
                      column. */}
                  <AdminTd>
                    <StatusPill tone={planTone(b.plan)}>{planLabel(b.plan)}</StatusPill>
                  </AdminTd>
                  <AdminTd truncate="max-w-[120px]">
                    <span title={b.subscriptionStatus ?? "No subscription"}>
                      {b.subscriptionStatus ? statusLabel(b.subscriptionStatus) : ADMIN_DASH}
                    </span>
                  </AdminTd>
                  <AdminTd align="right" numeric>
                    {fmtCredits(b.starter)}
                  </AdminTd>
                  <AdminTd align="right" numeric>
                    {fmtCredits(b.included)}
                  </AdminTd>
                  <AdminTd align="right" numeric>
                    {fmtCredits(b.purchased)}
                  </AdminTd>
                  <AdminTd align="right" numeric primary>
                    {fmtCredits(b.totalRemaining)}
                  </AdminTd>
                  <AdminTd align="right" numeric>
                    {b.dailyCreditCap === null ? "none" : fmtCredits(b.dailyCreditCap)}
                  </AdminTd>
                  <AdminTd>
                    {b.onDemandEnabled ? (
                      <StatusPill tone="info">on • {fmtCents(b.onDemandMonthlyLimitCents)}</StatusPill>
                    ) : (
                      ADMIN_DASH
                    )}
                  </AdminTd>
                  <AdminTd>
                    {b.anomalies.length === 0 ? (
                      ADMIN_DASH
                    ) : (
                      <StatusPill tone="danger" title={flagTitle}>
                        {b.anomalies.length === 1 ? b.anomalies[0].code : `${b.anomalies.length} flags`}
                      </StatusPill>
                    )}
                  </AdminTd>
                  <AdminTd>
                    <IdCell value={b.workspaceId} label="workspace id" />
                  </AdminTd>
                  <AdminTd align="right" sticky actions>
                    <RowActions>
                      <RowAction onClick={() => scopeTo(b.workspaceId)} title="Scope this page to that workspace">
                        {scoped ? "Scoped" : "Scope"}
                      </RowAction>
                    </RowActions>
                  </AdminTd>
                </AdminTr>
              );
            })
          )}
        </AdminTable>

        {balancesTotal > balancesReachableTotal ? (
          <p className={ADMIN_NOTE}>
            Sorted on a computed total no index can serve, so only the first{" "}
            {balancesReachableTotal.toLocaleString()} of {balancesTotal.toLocaleString()} rows can be paged through.
          </p>
        ) : null}

        {/* ------------------------------------------------------------- ledger */}
        <h2 className={`${ADMIN_SECTION_GAP} ${ADMIN_SECTION_TITLE}`}>Ledger ({scopeSuffix})</h2>
        <p className={ADMIN_SECTION_DESC}>
          The 50 most recent rows. Credits shows whichever of charged, reserved or estimated the row actually has.
        </p>

        {/* Table-scoped controls: no border, no panel, so this cannot be mistaken for the
            page's own band above. */}
        <div className={`mt-3 ${ADMIN_SUBBAR}`}>
          <AdminSelect
            ariaLabel="Filter ledger by event"
            value={ledgerEventType}
            onChange={(e) => setLedgerEventType(e.target.value)}
          >
            <option value="">All events</option>
            <option value="ai_run">AI runs</option>
            <option value="cycle_grant_included">Cycle grants</option>
            <option value="credit_pack_purchase">Pack purchases</option>
            <option value="credit_pack_expired">Pack expiries</option>
            <option value="free_floor_grant">Free floor (historic)</option>
          </AdminSelect>
          <AdminSelect
            ariaLabel="Filter ledger by status"
            value={ledgerStatus}
            onChange={(e) => setLedgerStatus(e.target.value)}
          >
            <option value="">Any status</option>
            <option value="pending">Pending</option>
            <option value="charged">Charged</option>
            <option value="refunded">Refunded</option>
            <option value="failed">Failed</option>
          </AdminSelect>
        </div>

        {ledgerError ? (
          <AdminAlert className="mt-3">
            {ledgerError}
          </AdminAlert>
        ) : null}

        <AdminTable
          className="mt-3"
          ariaLabel="Credit ledger"
          head={
            <>
              <AdminTh align="right">When</AdminTh>
              <AdminTh>Workspace</AdminTh>
              <AdminTh>Action</AdminTh>
              <AdminTh>Tier</AdminTh>
              <AdminTh>Status</AdminTh>
              <AdminTh>Event</AdminTh>
              <AdminTh align="right">Credits</AdminTh>
              <AdminTh>Bucket</AdminTh>
              <AdminTh>Source</AdminTh>
              <AdminTh align="right" sticky>
                Actions
              </AdminTh>
            </>
          }
        >
          {ledgerLoading && ledger.length === 0 ? (
            <AdminTableMessage colSpan={LEDGER_COLUMNS}>Loading ledger…</AdminTableMessage>
          ) : ledger.length === 0 ? (
            <AdminTableEmpty
              colSpan={LEDGER_COLUMNS}
              title="No ledger rows for this filter"
              hint="Try another event type or status, or clear the workspace scope."
            />
          ) : (
            ledger.map((r) => {
              const shown = creditsShown(r);
              return (
                <AdminTr key={r.id}>
                  <AdminTd align="right" numeric>
                    <TimeCell value={r.createdDate} />
                  </AdminTd>
                  <AdminTd primary truncate="max-w-[180px]">
                    <span title={r.workspaceName ?? r.workspaceId}>{r.workspaceName ?? r.workspaceId}</span>
                  </AdminTd>
                  <AdminTd truncate="max-w-[130px]">
                    <span title={r.actionType ?? undefined}>{r.actionType ?? ADMIN_DASH}</span>
                  </AdminTd>
                  <AdminTd>{r.qualityTier ?? ADMIN_DASH}</AdminTd>
                  <AdminTd>
                    <span className="inline-flex items-center gap-1.5">
                      {/* `charged` is every row but one: a chip drawn 49 times is decoration,
                          so the ordinary status is a word and only the exception is a chip. */}
                      {ledgerTone(r.status) === "quiet" ? (
                        statusLabel(r.status)
                      ) : (
                        <StatusPill tone={ledgerTone(r.status)}>{r.status}</StatusPill>
                      )}
                      {r.stalePending ? (
                        <StatusPill tone="danger" title="Pending far longer than a run should take">
                          Stale
                        </StatusPill>
                      ) : null}
                    </span>
                  </AdminTd>
                  <AdminTd truncate="max-w-[150px]">
                    <span title={r.eventType ?? undefined}>{r.eventType ?? ADMIN_DASH}</span>
                  </AdminTd>
                  <AdminTd
                    align="right"
                    numeric
                    title={`est ${fmtCredits(r.creditsEstimated)}, res ${fmtCredits(
                      r.creditsReserved,
                    )}, chg ${fmtCredits(r.creditsCharged)}`}
                  >
                    {/* The number alone: the basis is already the Status column's word, and
                        the tooltip carries all three figures. */}
                    <span className="font-medium text-[var(--fg)]">{fmtCredits(shown.value)}</span>
                  </AdminTd>
                  <AdminTd truncate="max-w-[160px]">
                    <span title={bucketSplitLabel(r.split)}>{bucketSplitLabel(r.split)}</span>
                  </AdminTd>
                  <AdminTd>
                    <span className="inline-flex items-center gap-1.5">
                      <span>{r.source ?? ADMIN_DASH}</span>
                      {r.adminReason ? (
                        <StatusPill tone="warning" title={r.adminReason}>
                          Admin
                        </StatusPill>
                      ) : null}
                    </span>
                  </AdminTd>
                  <AdminTd align="right" sticky actions>
                    <RowActions>
                      <RowAction onClick={() => scopeTo(r.workspaceId)} title="Scope this page to that workspace">
                        Scope
                      </RowAction>
                    </RowActions>
                  </AdminTd>
                </AdminTr>
              );
            })
          )}
        </AdminTable>

        {/* ---------------------------------------------------------- purchases */}
        <h2 className={`${ADMIN_SECTION_GAP} ${ADMIN_SECTION_TITLE}`}>Purchases ({scopeSuffix})</h2>
        <p className={ADMIN_SECTION_DESC}>
          Packs are Free-only at purchase time; a workspace keeps them after upgrading, so a live pack on Pro is normal.
        </p>

        {purchasesError ? (
          <AdminAlert className="mt-3">
            {purchasesError}
          </AdminAlert>
        ) : null}

        <AdminTable
          className="mt-3"
          ariaLabel="Credit pack purchases"
          head={
            <>
              <AdminTh align="right">Purchased</AdminTh>
              <AdminTh>Workspace</AdminTh>
              <AdminTh>Pack</AdminTh>
              <AdminTh align="right">Credits</AdminTh>
              <AdminTh align="right">Amount</AdminTh>
              <AdminTh align="right">Expires</AdminTh>
              <AdminTh>State</AdminTh>
              <AdminTh align="right" sticky>
                Actions
              </AdminTh>
            </>
          }
        >
          {purchasesLoading && purchases.length === 0 ? (
            <AdminTableMessage colSpan={PURCHASE_COLUMNS}>Loading purchases…</AdminTableMessage>
          ) : purchases.length === 0 ? (
            <AdminTableEmpty
              colSpan={PURCHASE_COLUMNS}
              title="No credit pack purchases"
              hint={scopedWorkspaceId ? "This workspace has never bought a pack." : undefined}
            />
          ) : (
            purchases.map((p) => (
              <AdminTr key={p.id}>
                <AdminTd align="right" numeric>
                  <TimeCell value={p.purchasedAt} />
                </AdminTd>
                <AdminTd primary truncate="max-w-[220px]">
                  <span title={p.workspaceName ?? p.workspaceId}>{p.workspaceName ?? p.workspaceId}</span>
                </AdminTd>
                <AdminTd truncate="max-w-[160px]">
                  <span title={p.packId ?? undefined}>{p.packId ?? ADMIN_DASH}</span>
                </AdminTd>
                <AdminTd align="right" numeric>
                  {fmtCredits(p.credits)}
                </AdminTd>
                <AdminTd align="right" numeric title={p.currency?.toUpperCase() ?? undefined}>
                  {fmtCents(p.amountCents)}
                </AdminTd>
                <AdminTd align="right" numeric>
                  <TimeCell value={p.expiresAt} mode="date" />
                </AdminTd>
                <AdminTd>
                  {p.expiredAt ? (
                    <StatusPill tone="quiet" title={`${fmtCredits(p.creditsExpired)} taken back`}>
                      expired
                    </StatusPill>
                  ) : p.pastExpiry ? (
                    <StatusPill tone="danger" title="Past its expiry and the sweep has not reclaimed it">
                      past expiry
                    </StatusPill>
                  ) : (
                    <StatusPill tone="positive" dot>
                      live
                    </StatusPill>
                  )}
                </AdminTd>
                <AdminTd align="right" sticky actions>
                  <RowActions>
                    <RowAction onClick={() => scopeTo(p.workspaceId)} title="Scope this page to that workspace">
                      Scope
                    </RowAction>
                  </RowActions>
                </AdminTd>
              </AdminTr>
            ))
          )}
        </AdminTable>

        {/* ---------------------------------------------------------- on-demand */}
        <h2 className={`${ADMIN_SECTION_GAP} ${ADMIN_SECTION_TITLE}`}>On-demand spend ({scopeSuffix})</h2>
        <p className={ADMIN_SECTION_DESC}>
          {onDemand
            ? scopedWorkspaceId
              ? onDemand.cycle
                ? `This cycle (${onDemand.cycle.cycleKey}): ${fmtCredits(
                    onDemand.cycle.onDemandUsedCredits,
                  )} on-demand of ${fmtCredits(onDemand.cycle.totalUsedCredits)} credits used.`
                : `No cycle total — ${onDemand.cycleUnavailableReason ?? "unavailable"}.`
              : `A rolling ${onDemand.windowDays}-day window: billing cycles start on a different day per workspace.`
            : "Metered credits billed beyond a workspace's included allowance."}
        </p>

        <AdminTable
          className="mt-3"
          ariaLabel="On-demand spend"
          head={
            <>
              <AdminTh>Workspace</AdminTh>
              <AdminTh align="right">On-demand credits</AdminTh>
              <AdminTh align="right">Runs</AdminTh>
              <AdminTh align="right" sticky>
                Actions
              </AdminTh>
            </>
          }
        >
          {purchasesLoading && !onDemand ? (
            <AdminTableMessage colSpan={ON_DEMAND_COLUMNS}>Loading on-demand spend…</AdminTableMessage>
          ) : !onDemand || onDemand.rows.length === 0 ? (
            <AdminTableEmpty
              colSpan={ON_DEMAND_COLUMNS}
              title="No on-demand credits billed in this window"
              hint="On-demand is Pro-only and only bills past the included allowance."
            />
          ) : (
            onDemand.rows.map((r) => (
              <AdminTr key={r.workspaceId}>
                <AdminTd primary truncate="max-w-[320px]">
                  <span title={r.workspaceName ?? r.workspaceId}>{r.workspaceName ?? r.workspaceId}</span>
                </AdminTd>
                <AdminTd
                  align="right"
                  numeric
                  title={rules ? `≈ ${fmtCents(r.credits * rules.usdCentsPerCredit)}` : undefined}
                >
                  {fmtCredits(r.credits)}
                  {rules ? (
                    <span className="text-[11.5px] text-[var(--muted-2)]">
                      {" "}
                      ≈ {fmtCents(r.credits * rules.usdCentsPerCredit)}
                    </span>
                  ) : null}
                </AdminTd>
                <AdminTd align="right" numeric>
                  {fmtCredits(r.runs)}
                </AdminTd>
                <AdminTd align="right" sticky actions>
                  <RowActions>
                    <RowAction onClick={() => scopeTo(r.workspaceId)} title="Scope this page to that workspace">
                      Scope
                    </RowAction>
                  </RowActions>
                </AdminTd>
              </AdminTr>
            ))
          )}
        </AdminTable>

        {/* -------------------------------------------------------------- tools */}
        <h2 className={`${ADMIN_SECTION_GAP} ${ADMIN_SECTION_TITLE}`}>Tools</h2>
        <p className={ADMIN_SECTION_DESC}>
          Everything above only reads. These four write, to the workspace in the scope field at the top.
        </p>

        <div className="mt-3 grid gap-2 xl:grid-cols-2">
          <Panel variant="panel" padding="md" rounded="xl" className="min-w-0">
            <div className="text-[13px] font-semibold leading-5 text-[var(--fg)]">Grant included credits</div>
            <div className="mt-2 grid gap-2 sm:grid-cols-[130px_minmax(0,1fr)]">
              <label className="min-w-0">
                <span className={ADMIN_FIELD_LABEL}>Amount</span>
                <Input
                  value={grantIncludedAmount}
                  onChange={(e) => setGrantIncludedAmount(e.target.value)}
                  variant="panel2"
                  className="mt-1 w-full"
                />
              </label>
              <label className="min-w-0">
                <span className={ADMIN_FIELD_LABEL}>Reason (required)</span>
                <Input
                  value={grantIncludedReason}
                  onChange={(e) => setGrantIncludedReason(e.target.value)}
                  variant="panel2"
                  className="mt-1 w-full"
                />
              </label>
            </div>
            <div className="mt-3">
              <Button
                variant="solid"
                className="bg-[var(--primary-bg)] text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)]"
                onClick={() => void runMutate("grant_included", grantIncludedAmount, grantIncludedReason)}
                disabled={snapshotLoading}
              >
                Grant credits
              </Button>
            </div>
          </Panel>

          <Panel variant="panel" padding="md" rounded="xl" className="min-w-0">
            <div className="text-[13px] font-semibold leading-5 text-[var(--fg)]">Grant on-demand credits</div>
            <div className="mt-2 grid gap-2 sm:grid-cols-[130px_minmax(0,1fr)]">
              <label className="min-w-0">
                <span className={ADMIN_FIELD_LABEL}>Amount</span>
                <Input
                  value={grantPaidAmount}
                  onChange={(e) => setGrantPaidAmount(e.target.value)}
                  variant="panel2"
                  className="mt-1 w-full"
                />
              </label>
              <label className="min-w-0">
                <span className={ADMIN_FIELD_LABEL}>Reason (required)</span>
                <Input
                  value={grantPaidReason}
                  onChange={(e) => setGrantPaidReason(e.target.value)}
                  variant="panel2"
                  className="mt-1 w-full"
                />
              </label>
            </div>
            <div className="mt-3">
              <Button
                variant="solid"
                className="bg-[var(--primary-bg)] text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)]"
                onClick={() => void runMutate("grant_on_demand", grantPaidAmount, grantPaidReason)}
                disabled={snapshotLoading}
              >
                Grant credits
              </Button>
            </div>
            <p className={ADMIN_NOTE}>Adds to the purchased (non-expiring) bucket.</p>
          </Panel>

          <Panel variant="panel" padding="md" rounded="xl" className="min-w-0">
            <div className="text-[13px] font-semibold leading-5 text-[var(--fg)]">Burn credits</div>
            {/* The button sits under the inputs, not beside them: squeezed into a third
                column its own label was cut to "Burn…", and a verb you cannot read is not a
                button. Irreversible, so it wears the danger tone the admin area uses for
                Delete rather than the neutral one that made it look safer. */}
            <div className="mt-2 grid gap-2 sm:grid-cols-[130px_minmax(0,1fr)]">
              <label className="min-w-0">
                <span className={ADMIN_FIELD_LABEL}>Amount</span>
                <Input
                  value={burnAmount}
                  onChange={(e) => setBurnAmount(e.target.value)}
                  variant="panel2"
                  className="mt-1 w-full"
                />
              </label>
              <label className="min-w-0">
                <span className={ADMIN_FIELD_LABEL}>Reason (required)</span>
                <Input
                  value={burnReason}
                  onChange={(e) => setBurnReason(e.target.value)}
                  variant="panel2"
                  className="mt-1 w-full"
                />
              </label>
            </div>
            <div className="mt-3">
              <Button
                variant="secondary"
                style={toneStyle("danger")}
                onClick={() => void runMutate("burn", burnAmount, burnReason)}
                disabled={snapshotLoading}
              >
                Burn credits
              </Button>
            </div>
            <p className={ADMIN_NOTE}>Asks once more before it takes the credits away.</p>
          </Panel>

          <Panel variant="panel" padding="md" rounded="xl" className="min-w-0">
            <div className="text-[13px] font-semibold leading-5 text-[var(--fg)]">Simulate new billing cycle</div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <label className="min-w-0">
                <span className={ADMIN_FIELD_LABEL}>Period start (unix s)</span>
                <Input
                  value={simStartUnix}
                  onChange={(e) => setSimStartUnix(e.target.value)}
                  variant="panel2"
                  className="mt-1 w-full"
                />
              </label>
              <label className="min-w-0">
                <span className={ADMIN_FIELD_LABEL}>Period end (unix s)</span>
                <Input
                  value={simEndUnix}
                  onChange={(e) => setSimEndUnix(e.target.value)}
                  variant="panel2"
                  className="mt-1 w-full"
                />
              </label>
            </div>
            <label className="mt-2 block min-w-0">
              <span className={ADMIN_FIELD_LABEL}>Reason (required)</span>
              <Input
                value={simReason}
                onChange={(e) => setSimReason(e.target.value)}
                variant="panel2"
                className="mt-1 w-full"
              />
            </label>
            {/* Same rule as Burn: full label, its own row, danger tone — it moves the stored
                billing period and applies a grant. */}
            <div className="mt-3">
              <Button
                variant="secondary"
                style={toneStyle("danger")}
                onClick={() => void runSimulateCycle()}
                disabled={snapshotLoading}
              >
                Simulate new cycle
              </Button>
            </div>
            <p className={ADMIN_NOTE}>
              Never calls Stripe. Moves the stored period boundaries and applies one cycle grant, idempotently.
            </p>
          </Panel>
        </div>
      </div>
    </div>
  );
}
