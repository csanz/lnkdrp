/**
 * Billing & Invoices tab content for `/dashboard?tab=billing` (and `/dashboard/billing` via redirect).
 *
 * Cursor-style layout:
 * - Included Usage (current cycle)
 * - On-Demand Usage (current cycle, with cycle selector)
 * - Invoices (month selector + View links)
 */
"use client";

import { useEffect, useMemo, useState } from "react";

import Panel from "@/components/ui/Panel";
import DataTable from "@/components/ui/DataTable";
import Select from "@/components/ui/Select";
import Alert from "@/components/ui/Alert";
import { UNLIMITED_LIMIT_CENTS } from "@/lib/billing/limits";
import { clampNonNegInt, formatInt } from "@/lib/format/number";
import { formatDateRange, formatMonthLabel, formatShortDate } from "@/lib/format/date";
import { formatUsdFromCents, formatUsdOrNotAvailable } from "@/lib/format/money";
import { openBillingPortal } from "@/lib/billing/clientActions";

type BillingSummary = {
  cycle: { start: string; end: string; key: string };
  plan: { name: string; status: string; cancelAtPeriodEnd: boolean };
  onDemand: { enabled: boolean; monthlyLimitCents: number; usedCentsThisCycle: number };
  balances: { includedRemaining: number; purchasedRemaining: number; trialRemaining: number; creditsRemaining: number };
};

type BillingUsage = {
  cycle: { start: string; end: string };
  included: {
    rows: Array<{ label: string; credits: number; costCents: number; costLabel: string }>;
    total: { label: string; credits: number; costCents: number; costLabel: string };
  };
  onDemand: {
    usedCents: number;
    limitCents: number;
    rows: Array<{ label: string; credits: number; costCents: number | null; qty: number; totalCents: number | null }>;
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

export default function BillingInvoicesTab() {
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summary, setSummary] = useState<BillingSummary | null>(null);

  const [usageBusy, setUsageBusy] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [usage, setUsage] = useState<BillingUsage | null>(null);

  const [invoicesBusy, setInvoicesBusy] = useState(false);
  const [invoicesError, setInvoicesError] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<BillingInvoices | null>(null);

  const [cycleStartIso, setCycleStartIso] = useState<string | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [manageBusy, setManageBusy] = useState(false);
  const [manageError, setManageError] = useState<string | null>(null);
  const [creditsInfoOpen, setCreditsInfoOpen] = useState(false);

  const cycleOptions = useMemo(() => {
    const start = summary?.cycle?.start;
    const end = summary?.cycle?.end;
    if (!start || !end) return [];
    const s = new Date(start);
    const e = new Date(end);
    if (!Number.isFinite(s.getTime()) || !Number.isFinite(e.getTime())) return [{ start, end, label: "Current cycle" }];
    const periodMs = Math.max(1, e.getTime() - s.getTime());

    const out: Array<{ start: string; end: string; label: string }> = [];
    for (let i = 0; i < 6; i++) {
      const cs = new Date(s.getTime() - i * periodMs);
      const ce = new Date(cs.getTime() + periodMs);
      const label = `Cycle Starting ${formatShortDate(cs.toISOString())}`;
      out.push({ start: cs.toISOString(), end: ce.toISOString(), label });
    }
    return out;
  }, [summary?.cycle?.start, summary?.cycle?.end]);

  useEffect(() => {
    let cancelled = false;
    setSummaryBusy(true);
    setSummaryError(null);
    void (async () => {
      try {
        const res = await fetch("/api/billing/summary", { method: "GET" });
        const json = (await res.json().catch(() => null)) as BillingSummary | { error?: string } | null;
        if (!res.ok) throw new Error((json as any)?.error || `Request failed (${res.status})`);
        if (!json || !(json as any).cycle) throw new Error("Invalid response");
        if (!cancelled) {
          setSummary(json as BillingSummary);
          setCycleStartIso((json as any).cycle?.start ?? null);
        }
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

  useEffect(() => {
    let cancelled = false;
    const start = cycleStartIso;
    if (!start) return;
    setUsageBusy(true);
    setUsageError(null);
    void (async () => {
      try {
        const qs = new URLSearchParams();
        qs.set("cycleStart", start);
        const res = await fetch(`/api/billing/usage?${qs.toString()}`, { method: "GET" });
        const json = (await res.json().catch(() => null)) as BillingUsage | { error?: string } | null;
        if (!res.ok) throw new Error((json as any)?.error || `Request failed (${res.status})`);
        if (!json || !(json as any).cycle) throw new Error("Invalid response");
        if (!cancelled) setUsage(json as BillingUsage);
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
  }, [cycleStartIso]);

  useEffect(() => {
    let cancelled = false;
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
  }, [selectedMonth]);

  async function openPortal() {
    setManageBusy(true);
    setManageError(null);
    try {
      await openBillingPortal({ target: "_blank" });
    } catch (e) {
      setManageError(e instanceof Error ? e.message : "Failed to open billing portal");
    } finally {
      setManageBusy(false);
    }
  }

  const cycleRange = summary?.cycle ? formatDateRange(summary.cycle.start, summary.cycle.end) : "";
  const includedRows = usage?.included?.rows ?? [];
  const includedTotal = usage?.included?.total ?? null;
  const onDemandRows = usage?.onDemand?.rows ?? [];
  const onDemandAdjustments = usage?.onDemand?.adjustments ?? [];
  const onDemandSubtotalCents = clampNonNegInt(usage?.onDemand?.subtotalCents ?? 0);
  const onDemandHasUnknownCost = onDemandRows.some((r) => r.totalCents === null || r.costCents === null);
  const onDemandLimitCents = clampNonNegInt(summary?.onDemand?.monthlyLimitCents ?? 0);
  const onDemandUnlimited = Boolean(summary?.onDemand?.enabled) && onDemandLimitCents >= UNLIMITED_LIMIT_CENTS;
  const onDemandLimitLabel = onDemandUnlimited ? "Unlimited" : formatUsdFromCents(onDemandLimitCents);

  const summaryLoaded = Boolean(summary) && !summaryBusy && !summaryError;
  const usageLoaded = Boolean(usage) && !usageBusy && !usageError;
  const invoicesLoaded = Boolean(invoices) && !invoicesBusy && !invoicesError;

  return (
    <div className="grid gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-[28px] font-semibold tracking-tight text-[var(--fg)]">Billing & Invoices</div>
        </div>
        <div className="shrink-0">
          <button
            type="button"
            className="rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-60"
            onClick={openPortal}
            disabled={manageBusy}
          >
            {manageBusy ? "Opening…" : "Manage subscription"}
          </button>
        </div>
      </div>

      {manageError ? (
        <Alert variant="error" className="text-[12px]">
          {manageError}
        </Alert>
      ) : null}

      {/* Card 1: Included Usage */}
      <Panel padding="lg">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[13px] font-semibold text-[var(--fg)]">Included Usage</div>
            <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">
              {summaryLoaded ? cycleRange : <SkeletonPill widthClassName="w-56" />}
            </div>
            <div className="mt-2 text-[12px] text-[var(--muted-2)]">
              Includes 300 credits per billing cycle. Credits reset on your renewal date.
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
          {!summaryLoaded || usageBusy || !usage ? (
            <SkeletonLines lines={4} />
          ) : usageError ? (
            <Alert variant="error" className="text-[12px]">
              {usageError}
            </Alert>
          ) : usageLoaded && includedRows.length === 0 ? (
            <div className="text-[12px] text-[var(--muted-2)]">No usage yet for this cycle.</div>
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
                  <tr key={r.label} className="border-t border-[var(--border)]">
                    <td className="px-4 py-3 text-[13px] text-[var(--muted-2)]">{r.label}</td>
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
            <div className="text-[13px] font-semibold text-[var(--fg)]">On-Demand Usage</div>
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
                  {formatUsdFromCents(clampNonNegInt(summary.onDemand.usedCentsThisCycle))}{" "}
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
            <div className="text-[12px] font-semibold text-[var(--muted-2)]">Cycle</div>
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
          {!summaryLoaded || usageBusy || !usage ? (
            <SkeletonLines lines={4} />
          ) : usageError ? (
            <Alert variant="error" className="text-[12px]">
              {usageError}
            </Alert>
          ) : summaryLoaded && summary && !summary.onDemand.enabled ? null : usageLoaded && onDemandRows.length === 0 ? (
            <div className="text-[12px] text-[var(--muted-2)]">No usage yet for this cycle.</div>
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
                    <tr key={r.label} className="border-t border-[var(--border)]">
                      <td className="px-4 py-3 text-[13px] text-[var(--muted-2)]">{r.label}</td>
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

        {invoicesError ? (
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
                    <td className="px-4 py-3 text-[13px] text-[var(--muted-2)]">{formatShortDate(inv.date)}</td>
                    <td className="px-4 py-3 text-[13px] text-[var(--muted-2)]">{inv.description}</td>
                    <td className="px-4 py-3 text-[13px] text-[var(--muted-2)]">{inv.status}</td>
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


