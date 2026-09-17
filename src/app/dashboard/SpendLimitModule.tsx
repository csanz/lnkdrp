/**
 * On-demand usage module used in:
 * - Dashboard Overview (inside Subscription card right slot)
 * - Dashboard Limits tab
 *
 * On-demand is Pro's overage: once the monthly credits run out, AI keeps working at a per-credit
 * price, billed on the next invoice, up to the limit set here. The editor can also turn it off.
 * Credits already used on-demand this cycle are billed either way (they are in the ledger and the
 * hourly Stripe report sends them regardless of the toggle), and the editor says so before a
 * change that would otherwise look like it cancels them.
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
import { formatShortDate } from "@/lib/format/date";
import { dispatchCreditsSnapshotRefresh } from "@/lib/client/creditsSnapshotRefresh";
import { FEATURE_CREDITS_ENABLED } from "@/lib/client/planLimit";
import Link from "next/link";

type SpendStatus = {
  ok: true;
  onDemandEnabled: boolean;
  onDemandMonthlyLimitCents: number;
  /** Billed on-demand this cycle; still reported after on-demand is turned off (still invoiced). */
  onDemandUsedCentsThisCycle: number;
  /** When this cycle's on-demand usage is invoiced and the limit starts counting again (Pro only). */
  cycleEnd?: string | null;
  isPro?: boolean;
  canEdit?: boolean;
  /** Not on Pro, but on-demand is still stored on: the owner can still turn it off. */
  canTurnOff?: boolean;
  editDisabledReason?: string | null;
  /** Not on Pro, so on-demand can't be turned on here: point at credit packs instead. */
  needsCard?: boolean;
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

function creditsFromCents(cents: number): number {
  return Math.floor(Math.max(0, Math.floor(cents)) / USD_CENTS_PER_CREDIT);
}

/** "500 credits", "1,000 credits". */
function creditsLabel(cents: number): string {
  return `${formatInt(creditsFromCents(cents))} credits`;
}

/** "$50", "$1,000", "$12.50": whole dollars without the cents. */
function usdShort(cents: number): string {
  const c = Math.max(0, Math.floor(cents));
  return c % 100 === 0 ? `$${formatInt(c / 100)}` : formatUsdFromCents(c);
}

/** Sentinel for the "Custom" choice while its dollar amount is typed. */
const CUSTOM = -1;

/** Choices in the editor, top to bottom. `0` is off. */
const CHOICES: ReadonlyArray<{ cents: number; title: string; detail: string }> = [
  { cents: 0, title: "Off", detail: "Stop when included credits run out." },
  ...ALLOWED_LIMITS.filter((c) => c > 0 && c < UNLIMITED_LIMIT_CENTS).map((c) => ({
    cents: c,
    title: usdShort(c),
    detail: `Up to ${creditsLabel(c)} a billing cycle`,
  })),
  { cents: UNLIMITED_LIMIT_CENTS, title: "No limit", detail: "Billed for whatever you use" },
];

/**
 * Spend limit module; on by default, renders nothing only when `NEXT_PUBLIC_FEATURE_CREDITS=0`.
 */
export default function SpendLimitModule(props: { className?: string; compact?: boolean }) {
  if (!FEATURE_CREDITS_ENABLED) return null;
  return <SpendLimitModuleInner {...props} />;
}

/** Spend limit body: on-demand usage summary plus the limit editor modal. */
function SpendLimitModuleInner({
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
  const [selected, setSelected] = useState<number | null>(null);
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

  const limitCents = typeof data?.onDemandMonthlyLimitCents === "number" ? data.onDemandMonthlyLimitCents : 0;
  const usedCents = typeof data?.onDemandUsedCentsThisCycle === "number" ? data.onDemandUsedCentsThisCycle : 0;
  const serverCanEdit = typeof data?.canEdit === "boolean" ? data.canEdit : true;
  const canTurnOff = data?.canTurnOff === true;
  const editDisabledReason = typeof data?.editDisabledReason === "string" ? data.editDisabledReason : null;
  const needsCard = data?.needsCard === true;
  const cycleEnd = typeof data?.cycleEnd === "string" ? data.cycleEnd : null;
  const resetLabel = cycleEnd ? formatShortDate(cycleEnd) : null;

  const isOff = limitCents === 0;
  const isUnlimited = limitCents >= UNLIMITED_LIMIT_CENTS;
  const progress = useMemo(() => {
    if (limitCents <= 0 || isUnlimited) return 0;
    return Math.max(0, Math.min(1, usedCents / limitCents));
  }, [limitCents, usedCents, isUnlimited]);

  const canEdit = !busy && !saveBusy && serverCanEdit;

  function openEditor() {
    if (!serverCanEdit) return;
    setSaveError(null);
    const preset = CHOICES.some((c) => c.cents === limitCents);
    setSelected(preset ? limitCents : CUSTOM);
    setCustomDollars(preset ? "" : String(Math.ceil(limitCents / 100)));
    setEditOpen(true);
  }

  function parseCustomCents(): number | null {
    const raw = customDollars.trim().replace(/^\$/, "");
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    // Dollars to cents, rounded up so a typed limit never ends up below what was asked for.
    return Math.min(UNLIMITED_LIMIT_CENTS, Math.ceil(n * 100));
  }

  const nextCents = selected === CUSTOM ? parseCustomCents() : selected;
  const unchanged = nextCents !== null && nextCents === limitCents;
  const saveDisabled = saveBusy || !canEdit || nextCents === null || unchanged;
  const turningOff = nextCents === 0 && !isOff;
  const belowUsed = nextCents !== null && nextCents > 0 && nextCents < UNLIMITED_LIMIT_CENTS && nextCents <= usedCents;

  async function saveLimit(next: number): Promise<boolean> {
    setSaveBusy(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/billing/spend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ spendLimitCents: next }),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
      await refresh({ force: true });
      window.dispatchEvent(new Event(SPEND_LIMIT_UPDATED_EVENT));
      // Ensure dashboard header badge + credits drawer re-fetch the snapshot without a full refresh.
      dispatchCreditsSnapshotRefresh();
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to save spend limit";
      setSaveError(message);
      if (!editOpen) setError(message);
      return false;
    } finally {
      setSaveBusy(false);
    }
  }

  async function save() {
    if (nextCents === null) return;
    if (await saveLimit(nextCents)) setEditOpen(false);
  }

  const usedLine =
    usedCents > 0
      ? `${creditsLabel(usedCents)} (${formatUsdFromCents(usedCents)}) used this cycle${isOff ? ", billed on your next invoice" : ""}`
      : null;

  return (
    <div className={cn("w-full rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-[12px] font-semibold text-[var(--fg)]">
              {compact ? "On-demand usage" : "On-demand usage this cycle"}
            </div>
            <HelpTooltip
              label="On-demand usage help"
              body={`A Pro feature. When your monthly credits run out, AI keeps working at ${formatUsdFromCents(USD_CENTS_PER_CREDIT)} a credit, billed on your next invoice, up to the limit you set.`}
              align="left"
            />
          </div>
          <div className="mt-1 min-h-[16px] text-[11px] text-[var(--muted-2)]">
            {busy && !data
              ? "Loading…"
              : !serverCanEdit
                ? editDisabledReason || "You don’t have permission to edit this limit."
                : isOff
                  ? "Off. AI stops when included credits run out."
                  : resetLabel
                    ? `Resets ${resetLabel}`
                    : " "}
          </div>
        </div>
        {serverCanEdit ? (
          <button
            type="button"
            className={cn(
              "shrink-0 whitespace-nowrap rounded-lg bg-[var(--panel-hover)] px-3 py-2 text-[12px] font-semibold",
              canEdit ? "text-[var(--fg)] hover:opacity-90" : "text-[var(--muted-2)] opacity-60",
            )}
            disabled={!canEdit}
            onClick={openEditor}
          >
            {isOff ? "Turn on" : "Edit limit"}
          </button>
        ) : canTurnOff ? (
          <button
            type="button"
            className="shrink-0 whitespace-nowrap rounded-lg bg-[var(--panel-hover)] px-3 py-2 text-[12px] font-semibold text-[var(--fg)] hover:opacity-90 disabled:opacity-60"
            disabled={saveBusy}
            onClick={() => void saveLimit(0)}
          >
            {saveBusy ? "Turning off…" : "Turn off"}
          </button>
        ) : null}
      </div>

      {isOff ? (
        usedLine ? <div className="mt-3 text-[12px] text-[var(--muted-2)]">{usedLine}</div> : null
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-semibold text-[var(--fg)]">
            <span>{creditsLabel(usedCents)}</span>
            <span className="text-[var(--muted-2)]">/</span>
            {isUnlimited ? (
              <span className="text-emerald-700 dark:text-emerald-300">No limit</span>
            ) : (
              <span className="text-[var(--muted-2)]">{creditsLabel(limitCents)}</span>
            )}
          </div>
          <div className="mt-1 text-[11px] text-[var(--muted-2)]">
            {formatUsdFromCents(usedCents)} / {isUnlimited ? "no limit" : formatUsdFromCents(limitCents)}
          </div>
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-[var(--panel-hover)]" aria-hidden="true">
            <div className="h-2 rounded-full bg-[var(--fg)]" style={{ width: `${Math.round(progress * 100)}%`, opacity: 0.55 }} />
          </div>
        </>
      )}

      {needsCard ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Link
            href="/credits"
            className="inline-flex items-center justify-center rounded-lg bg-[var(--fg)] px-3 py-2 text-[12px] font-semibold text-[var(--bg)]"
          >
            Add more credits
          </Link>
        </div>
      ) : null}

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
        ariaLabel="On-demand usage"
        width={500}
      >
        <div className="pr-10 text-[20px] font-semibold tracking-tight text-[var(--fg)]">On-demand usage</div>
        <div className="mt-1 text-[13px] leading-5 text-[var(--muted-2)]">
          When your monthly credits run out, AI keeps working at {formatUsdFromCents(USD_CENTS_PER_CREDIT)} a credit,
          billed on your next invoice. The limit caps what on-demand can spend each billing cycle.
        </div>

        <div className="mt-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-xl bg-[var(--panel-2)] px-4 py-3">
          <div className="text-[13px] text-[var(--muted-2)]">
            Used this cycle{" "}
            <span className="font-semibold text-[var(--fg)]">
              {formatInt(creditsFromCents(usedCents))} credits · {formatUsdFromCents(usedCents)}
            </span>
          </div>
          {resetLabel ? <div className="text-[12px] text-[var(--muted-2)]">Resets {resetLabel}</div> : null}
        </div>

        <div role="radiogroup" aria-label="On-demand limit" className="mt-4 grid gap-1">
          {[...CHOICES, { cents: CUSTOM, title: "Custom", detail: "Set your own dollar limit" }].map((c) => {
            const active = selected === c.cents;
            const current = c.cents === CUSTOM ? selected === CUSTOM && !CHOICES.some((x) => x.cents === limitCents) && limitCents > 0 : c.cents === limitCents;
            return (
              <button
                key={c.cents}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={saveBusy}
                onClick={() => setSelected(c.cents)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl border px-3.5 py-2 text-left transition-colors",
                  active
                    ? "border-[var(--fg)] bg-[var(--panel-hover)]"
                    : "border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel-hover)]",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "grid h-4 w-4 shrink-0 place-items-center rounded-full border",
                    active ? "border-[var(--fg)]" : "border-[var(--muted-2)]",
                  )}
                >
                  {active ? <span className="h-2 w-2 rounded-full bg-[var(--fg)]" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-semibold text-[var(--fg)]">{c.title}</span>
                  <span className="block text-[12px] text-[var(--muted-2)]">{c.detail}</span>
                </span>
                {current ? (
                  <span className="shrink-0 rounded-md bg-[var(--panel-2)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--muted-2)]">
                    Current
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        {selected === CUSTOM ? (
          <div className="mt-3">
            <label className="text-[12px] font-semibold text-[var(--fg)]" htmlFor="customLimit">
              Limit per billing cycle (USD)
            </label>
            <div className="mt-1.5 flex items-center gap-2">
              <div className="relative w-full">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[14px] text-[var(--muted-2)]">$</span>
                <input
                  id="customLimit"
                  inputMode="decimal"
                  autoFocus
                  placeholder="300"
                  value={customDollars}
                  onChange={(e) => setCustomDollars(e.target.value)}
                  className="w-full rounded-xl border border-[var(--border)] bg-[var(--panel-2)] py-2 pl-7 pr-3 text-[14px] text-[var(--fg)] outline-none focus:border-[var(--muted-2)]"
                  disabled={saveBusy}
                />
              </div>
            </div>
            <div className="mt-1.5 text-[12px] text-[var(--muted-2)]">
              {parseCustomCents() !== null ? `Up to ${creditsLabel(parseCustomCents() ?? 0)} a billing cycle.` : "Enter an amount in dollars."}
            </div>
          </div>
        ) : null}

        {turningOff ? (
          <Alert className="mt-4 text-[12px] leading-5">
            {usedCents > 0 ? (
              <>
                The <span className="font-semibold text-[var(--fg)]">{formatUsdFromCents(usedCents)}</span> already used
                this cycle is still billed on your next invoice. Turning off stops new on-demand usage only.{" "}
              </>
            ) : null}
            Once your included credits run out, AI summaries and compares are skipped
            {resetLabel ? ` until they reset on ${resetLabel}` : " until they reset"}.
          </Alert>
        ) : belowUsed ? (
          <Alert className="mt-4 text-[12px] leading-5">
            This cycle has already used {formatUsdFromCents(usedCents)}, which is at or above this limit. That usage is
            still billed, and on-demand stays paused{resetLabel ? ` until ${resetLabel}` : " until the cycle resets"}.
          </Alert>
        ) : null}

        {saveError ? (
          <Alert variant="error" className="mt-4 text-[12px]">
            {saveError}
          </Alert>
        ) : null}

        <div className="mt-5 flex items-center justify-end gap-2">
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
            {saveBusy ? "Saving…" : turningOff ? "Turn off on-demand" : isOff ? "Turn on" : "Save limit"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
