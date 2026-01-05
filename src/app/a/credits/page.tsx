/**
 * Admin route: `/a/credits`
 *
 * Admin-only tools to inspect and safely mutate workspace credits via the ledger system.
 */
"use client";

import { signIn, useSession } from "next-auth/react";
import Link from "next/link";
import { useMemo, useState } from "react";

import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Panel from "@/components/ui/Panel";
import { fetchJson } from "@/lib/http/fetchJson";

type AdminCreditsSnapshotResponse = {
  ok: true;
  workspaceId: string;
  plan: string;
  stripeSubscriptionId: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
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

function isPositiveIntString(v: string): boolean {
  const s = v.trim();
  if (!s) return false;
  const n = Number(s);
  return Number.isFinite(n) && Math.floor(n) === n && n >= 1;
}

function clampAmount(n: number): number {
  return Math.max(1, Math.min(1_000_000, Math.floor(n)));
}

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
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

  async function loadSnapshot(nextWorkspaceId?: string) {
    const ws = (nextWorkspaceId ?? workspaceId).trim();
    setSuccess(null);
    setError(null);
    if (!ws) {
      setError("workspaceId is required");
      return;
    }
    setLoading(true);
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
      setLoading(false);
    }
  }

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

    setLoading(true);
    try {
      await fetchJson(`/api/admin/credits/mutate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: ws, action, amount, reason: reason.trim() }),
      });
      await loadSnapshot(ws);
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
      setLoading(false);
    }
  }

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

    setLoading(true);
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
      setSuccess(`Simulated cycle. cycleKey=${res.cycleKey}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to simulate cycle");
    } finally {
      setLoading(false);
    }
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
      <div className="mx-auto w-full max-w-5xl px-6 py-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-[var(--fg)]">Admin / Credits</h1>
            <p className="mt-1 text-sm text-[var(--muted)]">Inspect and safely mutate workspace credits via the ledger.</p>
          </div>
          <Link
            href="/a"
            className="inline-flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm font-semibold text-[var(--fg)] transition hover:bg-[var(--panel-hover)]"
          >
            Admin home
          </Link>
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

        <div className="mt-6 grid gap-4">
          <Panel className="min-w-0">
            <div className="text-sm font-semibold text-[var(--fg)]">Workspace selector</div>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <div className="min-w-[340px] flex-1">
                <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">workspaceId</div>
                <Input
                  value={workspaceId}
                  onChange={(e) => setWorkspaceId(e.target.value)}
                  placeholder="Mongo ObjectId (org/workspace)"
                  variant="panel2"
                  className="mt-1 w-full"
                />
              </div>
              <Button
                variant="solid"
                className="bg-[var(--primary-bg)] text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)]"
                onClick={() => void loadSnapshot()}
                disabled={loading}
              >
                Load snapshot
              </Button>
            </div>
          </Panel>

          <Panel className="min-w-0">
            <div className="text-sm font-semibold text-[var(--fg)]">Current credits snapshot</div>
            <div className="mt-3 grid gap-2 text-sm">
              <div className="grid gap-1 text-[13px] text-[var(--muted)]">
                <div>
                  <span className="font-semibold text-[var(--fg)]">Credits remaining:</span>{" "}
                  {normalizedSnapshot ? normalizedSnapshot.creditsRemaining : "—"}
                </div>
                <div>
                  <span className="font-semibold text-[var(--fg)]">Included remaining:</span>{" "}
                  {normalizedSnapshot ? normalizedSnapshot.includedRemaining : "—"}
                </div>
                <div>
                  <span className="font-semibold text-[var(--fg)]">Paid remaining:</span>{" "}
                  {normalizedSnapshot ? normalizedSnapshot.paidRemaining : "—"}
                </div>
                <div>
                  <span className="font-semibold text-[var(--fg)]">Cycle start/end:</span>{" "}
                  {normalizedSnapshot ? `${normalizedSnapshot.cycleStart ?? "—"} → ${normalizedSnapshot.cycleEnd ?? "—"}` : "—"}
                </div>
                <div>
                  <span className="font-semibold text-[var(--fg)]">Plan:</span> {data ? data.plan : "—"}
                </div>
                <div>
                  <span className="font-semibold text-[var(--fg)]">On-demand:</span>{" "}
                  {normalizedSnapshot
                    ? `${normalizedSnapshot.onDemandEnabled ? "enabled" : "disabled"} • limit=${data?.onDemandLimitCredits ?? 0} credits`
                    : "—"}
                </div>
                <div>
                  <span className="font-semibold text-[var(--fg)]">Stripe subscription:</span>{" "}
                  {data?.stripeSubscriptionId ?? "—"}
                </div>
                <div>
                  <span className="font-semibold text-[var(--fg)]">cycleKey:</span> {data?.cycleKey ?? "—"}
                </div>
              </div>
            </div>
          </Panel>

          <Panel className="min-w-0">
            <div className="text-sm font-semibold text-[var(--fg)]">Actions</div>
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
                      disabled={loading}
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
                      disabled={loading}
                    >
                      Grant
                    </Button>
                  </div>
                </div>
                <div className="text-xs text-[var(--muted-2)]">Note: This adds to the paid (non-expiring) credit bucket.</div>
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
                    <Button variant="secondary" onClick={() => void runMutate("burn", burnAmount, burnReason)} disabled={loading}>
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
                    <Button variant="secondary" onClick={() => void runSimulateCycle()} disabled={loading}>
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
    </div>
  );
}


