/**
 * Spend limit UI module (Cursor-style) used in:
 * - Dashboard Overview (inside Subscription card right slot)
 * - Dashboard Usage tab (top section)
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import Modal from "@/components/modals/Modal";
import Alert from "@/components/ui/Alert";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { cn } from "@/lib/cn";
import { ALLOWED_LIMITS, UNLIMITED_LIMIT_CENTS } from "@/lib/billing/limits";
import { USD_CENTS_PER_CREDIT } from "@/lib/billing/pricing";
import { formatInt } from "@/lib/format/number";
import { formatUsdFromCents } from "@/lib/format/money";
import { dispatchCreditsSnapshotRefresh } from "@/lib/client/creditsSnapshotRefresh";

type SpendStatus = {
  ok: true;
  onDemandEnabled: boolean;
  onDemandMonthlyLimitCents: number;
  onDemandUsedCentsThisCycle: number;
  canEdit?: boolean;
  editDisabledReason?: string | null;
};

export const SPEND_LIMIT_UPDATED_EVENT = "lnkdrp:spend-limit-updated";

// Simple in-memory cache to prevent visible "loading" / layout shift when navigating
// between dashboard tabs (tab switches unmount/remount this module).
const SPEND_STATUS_CACHE_TTL_MS = 30_000;
let spendStatusCache: { data: SpendStatus; at: number } | null = null;
let spendStatusInflight: Promise<SpendStatus> | null = null;

export function getCachedSpendStatus(): SpendStatus | null {
  return spendStatusCache?.data ?? null;
}

export async function refreshSpendStatus({
  maxAgeMs = SPEND_STATUS_CACHE_TTL_MS,
  force = false,
}: {
  maxAgeMs?: number;
  force?: boolean;
} = {}): Promise<SpendStatus> {
  const cachedAt = spendStatusCache?.at ?? 0;
  const cachedFresh = Boolean(spendStatusCache?.data) && Date.now() - cachedAt < maxAgeMs;
  if (!force && cachedFresh && spendStatusCache?.data) return spendStatusCache.data;

  if (spendStatusInflight) return await spendStatusInflight;
  spendStatusInflight = (async () => {
    try {
      const res = await fetch("/api/billing/spend", { method: "GET" });
      const json = (await res.json().catch(() => null)) as SpendStatus | { error?: string } | null;
      if (!res.ok) throw new Error((json as any)?.error || `Request failed (${res.status})`);
      if (!json || (json as any).ok !== true) throw new Error("Invalid response");
      spendStatusCache = { data: json as SpendStatus, at: Date.now() };
      return json as SpendStatus;
    } finally {
      spendStatusInflight = null;
    }
  })();
  return await spendStatusInflight;
}

function dollarsFromCents(cents: number): number {
  return Math.max(0, Math.floor(cents)) / 100;
}

function creditsFromCents(cents: number): number {
  return Math.max(0, Math.floor(cents)) / USD_CENTS_PER_CREDIT;
}

function presetLabel(limitCents: number): string {
  if (limitCents >= UNLIMITED_LIMIT_CENTS) return "Unlimited";
  const credits = Math.round(creditsFromCents(limitCents));
  const usd = formatUsdFromCents(limitCents);
  return `${formatInt(credits)} credits (${usd})`;
}

function isPreset(limitCents: number): boolean {
  return (ALLOWED_LIMITS as readonly number[]).includes(limitCents);
}

export default function SpendLimitModule({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SpendStatus | null>(() => spendStatusCache?.data ?? null);

  const [editOpen, setEditOpen] = useState(false);
  const [selectedLimitCents, setSelectedLimitCents] = useState<number | null>(null);
  const [customDollars, setCustomDollars] = useState<string>("");
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function refresh({ silent, force }: { silent?: boolean; force?: boolean } = {}) {
    if (!silent) setBusy(true);
    setError(null);
    try {
      const next = await refreshSpendStatus({ force: Boolean(force) });
      setData(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load spend");
    } finally {
      if (!silent) setBusy(false);
    }
  }

  useEffect(() => {
    const cachedAt = spendStatusCache?.at ?? 0;
    const cachedFresh = Boolean(spendStatusCache?.data) && Date.now() - cachedAt < SPEND_STATUS_CACHE_TTL_MS;
    void refresh({ silent: cachedFresh });
    const onUpdated = () => void refresh({ force: true });
    window.addEventListener(SPEND_LIMIT_UPDATED_EVENT, onUpdated);
    return () => window.removeEventListener(SPEND_LIMIT_UPDATED_EVENT, onUpdated);
  }, []);

  const spendLimitCents = typeof data?.onDemandMonthlyLimitCents === "number" ? data.onDemandMonthlyLimitCents : 0;
  const spendUsedCents = typeof data?.onDemandUsedCentsThisCycle === "number" ? data.onDemandUsedCentsThisCycle : 0;
  const serverCanEdit = typeof data?.canEdit === "boolean" ? data.canEdit : true;
  const editDisabledReason = typeof data?.editDisabledReason === "string" ? data.editDisabledReason : null;

  const isUnlimited = spendLimitCents >= UNLIMITED_LIMIT_CENTS;
  const limitLabel = spendLimitCents === 0 ? "Disabled" : isUnlimited ? "Unlimited" : formatUsdFromCents(spendLimitCents);
  const usedLabel = formatUsdFromCents(spendUsedCents);
  const usedCreditsLabel = `${formatInt(Math.round(creditsFromCents(spendUsedCents)))} credits`;
  const onDemandDisabled = spendLimitCents === 0;
  const limitCreditsLabelSafe =
    spendLimitCents === 0
      ? "Disabled"
      : isUnlimited
        ? "Unlimited"
        : `${formatInt(Math.round(creditsFromCents(spendLimitCents)))} credits`;
  const progress = useMemo(() => {
    if (spendLimitCents <= 0 || isUnlimited) return 0;
    return Math.max(0, Math.min(1, spendUsedCents / spendLimitCents));
  }, [spendLimitCents, spendUsedCents, isUnlimited]);

  const canEdit = !busy && !saveBusy && serverCanEdit;

  function openEditor() {
    if (!serverCanEdit) return;
    setSaveError(null);
    setSelectedLimitCents(spendLimitCents);
    if (spendLimitCents > 0 && !isPreset(spendLimitCents) && spendLimitCents < UNLIMITED_LIMIT_CENTS) {
      setCustomDollars(String(Math.ceil(dollarsFromCents(spendLimitCents))));
    } else {
      setCustomDollars("");
    }
    setEditOpen(true);
  }

  function parseCustomCents(): number | null {
    const raw = customDollars.trim();
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    if (n <= 0) return null;
    // dollars -> cents, round up to ensure hard limit isn't under-charging.
    return Math.min(UNLIMITED_LIMIT_CENTS, Math.ceil(n * 100));
  }

  const effectiveSelectedCents = useMemo(() => {
    if (selectedLimitCents === null) return null;
    // If user chose "Custom", we store a sentinel of -1 in state and compute from input.
    if (selectedLimitCents === -1) return parseCustomCents();
    return selectedLimitCents;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLimitCents, customDollars]);

  const saveDisabled =
    saveBusy ||
    !canEdit ||
    effectiveSelectedCents === null ||
    (selectedLimitCents === -1 && parseCustomCents() === null);

  async function save() {
    const next = effectiveSelectedCents;
    if (next === null) return;
    setSaveBusy(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/billing/spend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ spendLimitCents: next }),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; onDemandMonthlyLimitCents?: number; error?: string } | null;
      if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
      setEditOpen(false);
      await refresh({ force: true });
      window.dispatchEvent(new Event(SPEND_LIMIT_UPDATED_EVENT));
      // Ensure dashboard header badge + credits drawer re-fetch the snapshot without a full refresh.
      dispatchCreditsSnapshotRefresh();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to save spend limit");
    } finally {
      setSaveBusy(false);
    }
  }

  const presets = [
    { cents: 5_000, label: "$50" },
    { cents: 10_000, label: "$100" },
    { cents: 20_000, label: "$200" },
    { cents: 50_000, label: "$500" },
    { cents: UNLIMITED_LIMIT_CENTS, label: "Unlimited" },
  ];

  const selectedIsCustom =
    selectedLimitCents === -1 ||
    (selectedLimitCents !== null && selectedLimitCents > 0 && !isPreset(selectedLimitCents) && selectedLimitCents < UNLIMITED_LIMIT_CENTS);

  return (
    <div className={cn("w-full rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-[12px] font-semibold text-[var(--fg)]">
              {compact ? "On-Demand Usage" : "On-Demand Usage this Cycle"}
            </div>
            <HelpTooltip
              label="On-demand usage help"
              body="On-demand usage lets you keep using AI after included credits are exhausted, up to your on-demand limit for the billing cycle."
              align="left"
            />
          </div>
          <div className="mt-1 min-h-[16px] text-[11px] text-[var(--muted-2)]">
            {busy && !data
              ? "Loading…"
              : !serverCanEdit
                ? editDisabledReason || "You don’t have permission to edit this limit."
                : onDemandDisabled
                  ? "Set a spend limit to enable on-demand usage."
                  : "\u00A0"}
          </div>
        </div>
        <button
          type="button"
          className={cn(
            "shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-[12px] font-semibold",
            !canEdit
              ? "bg-[var(--panel-hover)] text-[var(--muted-2)] opacity-60"
              : onDemandDisabled
                ? "bg-[var(--panel-hover)] text-[var(--fg)] hover:opacity-90"
                : "bg-[var(--panel-hover)] text-[var(--fg)] hover:opacity-90",
          )}
          disabled={!canEdit}
          onClick={openEditor}
        >
          {onDemandDisabled ? "Set limit" : "Edit limit"}
        </button>
      </div>

      <div className="mt-3 flex items-center gap-2 text-[13px] font-semibold text-[var(--fg)]">
        <span>{spendLimitCents === 0 ? "—" : usedCreditsLabel}</span>
        <span className="text-[var(--muted-2)]">/</span>
        {isUnlimited ? (
          <span className="text-emerald-700 dark:text-emerald-300">∞</span>
        ) : (
          <span className="text-[var(--muted-2)]">{limitCreditsLabelSafe}</span>
        )}
      </div>
      <div className="mt-1 text-[11px] text-[var(--muted-2)]">{spendLimitCents === 0 ? "\u00A0" : `${usedLabel} / ${limitLabel}`}</div>

      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-[var(--panel-hover)]" aria-hidden="true">
        <div className="h-2 rounded-full bg-[var(--fg)]" style={{ width: `${Math.round(progress * 100)}%`, opacity: 0.55 }} />
      </div>

      {error ? (
        <Alert variant="error" className="mt-3 text-[12px]">
          {error}
        </Alert>
      ) : null}

      <Modal
        open={editOpen}
        onClose={() => {
          if (saveBusy) return;
          setEditOpen(false);
        }}
        ariaLabel="Set spend limit"
      >
        <div className="text-[20px] font-semibold tracking-tight text-[var(--fg)]">Set On-Demand Limit</div>
        <div className="mt-1 text-[13px] text-[var(--muted-2)]">Credits-first limit (per billing cycle). Dollars are shown as a reference.</div>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          {presets.map((p) => {
            const active = selectedLimitCents === p.cents || (p.cents === UNLIMITED_LIMIT_CENTS && selectedLimitCents === UNLIMITED_LIMIT_CENTS);
            return (
              <button
                key={p.label}
                type="button"
                className={cn(
                  "rounded-lg border px-3 py-1.5 text-[13px] font-semibold",
                  active
                    ? "border-[var(--border)] bg-[var(--panel-hover)] text-[var(--fg)]"
                    : "border-[var(--border)] bg-[var(--panel)] text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
                )}
                onClick={() => {
                  setSelectedLimitCents(p.cents);
                }}
              >
                {presetLabel(p.cents)}
              </button>
            );
          })}

          <button
            type="button"
            className={cn(
              "rounded-lg border px-3 py-1.5 text-[13px] font-semibold",
              selectedIsCustom
                ? "border-[var(--border)] bg-[var(--panel-hover)] text-[var(--fg)]"
                : "border-[var(--border)] bg-[var(--panel)] text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
            )}
            onClick={() => setSelectedLimitCents(-1)}
          >
            Custom
          </button>
        </div>

        {selectedIsCustom ? (
          <div className="mt-4">
            <label className="text-[12px] font-semibold text-[var(--fg)]" htmlFor="customLimit">
              Custom limit (USD)
            </label>
            <div className="mt-2 flex items-center gap-2">
              <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-[14px] text-[var(--muted-2)]">
                $
              </div>
              <input
                id="customLimit"
                inputMode="decimal"
                placeholder="e.g. 300"
                value={customDollars}
                onChange={(e) => setCustomDollars(e.target.value)}
                className="w-full rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-[14px] text-[var(--fg)] outline-none focus:border-[var(--muted-2)]"
                disabled={saveBusy}
              />
            </div>
            <div className="mt-2 text-[12px] text-[var(--muted-2)]">We’ll round up to the nearest cent.</div>
          </div>
        ) : null}

        {saveError ? (
          <Alert variant="error" className="mt-4 text-[12px]">
            {saveError}
          </Alert>
        ) : null}

        <div className="mt-6 flex items-center justify-end gap-2">
          <button
            type="button"
            className="rounded-xl bg-[var(--panel-hover)] px-4 py-2 text-[13px] font-semibold text-[var(--fg)]"
            disabled={saveBusy}
            onClick={() => setEditOpen(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-[var(--fg)] px-4 py-2 text-[13px] font-semibold text-[var(--bg)] disabled:opacity-60"
            disabled={saveDisabled}
            onClick={() => void save()}
          >
            {saveBusy ? "Saving…" : "Save"}
          </button>
        </div>
      </Modal>
    </div>
  );
}


