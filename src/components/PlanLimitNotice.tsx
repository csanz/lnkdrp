/**
 * PlanLimitNotice — the quiet inline upgrade prompt for passive states (the sidebar's fallback
 * nudge, the New-project modal at cap). Blocking moments open `UpgradeModal` through
 * `useUpgradeModal()` instead of rendering this.
 *
 * Title and reason come from the shared `UPSELL_COPY` registry; "{used} of {max} used." and the
 * launch grace hint are appended when a parsed 402 body is supplied. **Upgrade to Pro** opens the
 * upgrade modal for the same key (override with `onUpgrade`); the optional secondary action is
 * caller-supplied (button via `onSecondary`, link via `secondaryHref`); `onDismiss` adds a small
 * × icon. Panel styling so it sits inside modals, side panels, and the sidebar without looking
 * like an error.
 */
"use client";

import Link from "next/link";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { cn } from "@/lib/cn";
import { useUpgradeModal } from "@/components/UpgradeModalProvider";
import { planLimitGraceHint, planLimitUsageSuffix, type PlanLimitError, type PlanLimitKey } from "@/lib/client/planLimit";
import { UPSELL_COPY, upsellKeyForLimit } from "@/lib/client/upsellCopy";

type Props = {
  /** Parsed 402 body; when omitted, copy is derived from `limit`. */
  error?: PlanLimitError | null;
  /** Limit to build copy for when no parsed error is available. */
  limit?: PlanLimitKey;
  /** Label for the secondary action; falls back to the per-limit default. Hidden when `onSecondary` and `secondaryHref` are both absent. */
  secondaryLabel?: string;
  /** Click handler for the secondary action (rendered as a button). */
  onSecondary?: () => void;
  /** Href for the secondary action (rendered as a link) when no `onSecondary` is given. */
  secondaryHref?: string;
  /** Override for the primary action; defaults to opening the upgrade modal for this limit. */
  onUpgrade?: () => void;
  /** Optional dismiss handler; renders a small × icon. */
  onDismiss?: () => void;
  /** Tighter spacing for narrow containers (sidebar). */
  compact?: boolean;
  className?: string;
};

/**
 * Inline plan-limit notice with an upgrade action and an optional secondary action.
 */
export default function PlanLimitNotice({
  error,
  limit,
  secondaryLabel,
  onSecondary,
  secondaryHref,
  onUpgrade,
  onDismiss,
  compact = false,
  className,
}: Props) {
  const { openUpgrade } = useUpgradeModal();
  const key: PlanLimitKey = error?.limit ?? limit ?? "documents";
  const upsellKey = upsellKeyForLimit(key);
  const copy = UPSELL_COPY[upsellKey];
  const usage = planLimitUsageSuffix({ used: error?.used, max: error?.max });
  const hint = planLimitGraceHint(error);
  const message = [copy.reason, usage, hint ?? ""].filter(Boolean).join(" ");
  const secondary = secondaryLabel ?? copy.secondaryLabel ?? "Compare plans";
  const handleUpgrade =
    onUpgrade ?? (() => openUpgrade(upsellKey, { used: error?.used, max: error?.max, graceHint: hint }));

  const actionBase = compact
    ? "rounded-lg px-2 py-1 text-[11px] font-semibold"
    : "rounded-lg px-3 py-1.5 text-[12px] font-semibold";
  const secondaryClass = cn(
    actionBase,
    "border border-[var(--border)] bg-[var(--panel)] text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
  );

  return (
    <div
      role="status"
      className={cn(
        "rounded-xl border border-[var(--border)] bg-[var(--panel-2)]",
        compact ? "px-3 py-2" : "px-4 py-3",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className={cn("font-semibold text-[var(--fg)]", compact ? "text-[12px]" : "text-[13px]")}>{copy.title}</div>
          <div className={cn("mt-0.5 text-[var(--muted-2)]", compact ? "text-[11px] leading-4" : "text-[12px] leading-5")}>
            {message}
          </div>
        </div>
        {onDismiss ? (
          <button
            type="button"
            className="-mr-1 -mt-1 shrink-0 rounded-md p-1 text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            onClick={onDismiss}
            aria-label="Dismiss"
          >
            <XMarkIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div className={cn("flex flex-wrap items-center gap-2", compact ? "mt-2" : "mt-3")}>
        <button
          type="button"
          className={cn(actionBase, "bg-[var(--primary-bg)] text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)]")}
          onClick={handleUpgrade}
        >
          {copy.primaryLabel ?? "Upgrade to Pro"}
        </button>
        {onSecondary ? (
          <button type="button" className={secondaryClass} onClick={onSecondary}>
            {secondary}
          </button>
        ) : secondaryHref ? (
          <Link href={secondaryHref} className={secondaryClass}>
            {secondary}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
