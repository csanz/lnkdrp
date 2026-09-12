/**
 * PlanLimitNotice — compact inline upgrade prompt shown after a `402 plan_limit` response.
 *
 * Renders the server's message, an "Upgrade to Pro" link to `/pricing`, and an optional secondary
 * action supplied by the caller (e.g. "Manage links"). Panel styling so it sits inside modals, side
 * panels, and the sidebar without looking like an error.
 */
"use client";

import Link from "next/link";
import { cn } from "@/lib/cn";
import { planLimitPrompt, type PlanLimitError, type PlanLimitKey } from "@/lib/client/planLimit";

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
  /** Optional dismiss handler; renders a small "Dismiss" control. */
  onDismiss?: () => void;
  /** Tighter spacing for narrow containers (sidebar). */
  compact?: boolean;
  className?: string;
};

/** Format the grace-period hint, when the workspace is still inside its window. */
function graceHint(error: PlanLimitError | null | undefined): string | null {
  const g = error?.grace;
  if (!g || g.blockedAt) return null;
  const ends = Date.parse(g.endsAt);
  if (!Number.isFinite(ends)) return null;
  const daysLeft = Math.max(0, Math.ceil((ends - Date.now()) / 86_400_000));
  if (daysLeft <= 0) return null;
  return `Grace period: ${daysLeft} ${daysLeft === 1 ? "day" : "days"} left.`;
}

/**
 * Inline plan-limit notice with an upgrade link and an optional secondary action.
 */
export default function PlanLimitNotice({
  error,
  limit,
  secondaryLabel,
  onSecondary,
  secondaryHref,
  onDismiss,
  compact = false,
  className,
}: Props) {
  const key: PlanLimitKey = error?.limit ?? limit ?? "active_links";
  const prompt = planLimitPrompt(key, { used: error?.used, max: error?.max });
  const message = error?.message || prompt.message;
  const upgradeUrl = error?.upgradeUrl || "/pricing";
  const secondary = secondaryLabel ?? prompt.secondaryLabel;
  const hint = graceHint(error);

  const actionBase = compact
    ? "rounded-lg px-2 py-1 text-[11px] font-semibold"
    : "rounded-lg px-3 py-1.5 text-[12px] font-semibold";

  return (
    <div
      role="status"
      className={cn(
        "rounded-xl border border-[var(--border)] bg-[var(--panel-2)]",
        compact ? "px-3 py-2" : "px-4 py-3",
        className,
      )}
    >
      <div className={cn("font-semibold text-[var(--fg)]", compact ? "text-[12px]" : "text-[13px]")}>{prompt.title}</div>
      <div className={cn("mt-0.5 text-[var(--muted-2)]", compact ? "text-[11px] leading-4" : "text-[12px] leading-5")}>
        {message}
        {hint ? <> {hint}</> : null}
      </div>
      <div className={cn("flex flex-wrap items-center gap-2", compact ? "mt-2" : "mt-3")}>
        <Link href={upgradeUrl} className={cn(actionBase, "bg-[var(--fg)] text-[var(--bg)] hover:opacity-90")}>
          Upgrade to Pro
        </Link>
        {onSecondary ? (
          <button
            type="button"
            className={cn(
              actionBase,
              "border border-[var(--border)] bg-[var(--panel)] text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
            )}
            onClick={onSecondary}
          >
            {secondary}
          </button>
        ) : secondaryHref ? (
          <Link
            href={secondaryHref}
            className={cn(
              actionBase,
              "border border-[var(--border)] bg-[var(--panel)] text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
            )}
          >
            {secondary}
          </Link>
        ) : null}
        {onDismiss ? (
          <button
            type="button"
            className={cn("ml-auto text-[var(--muted-2)] hover:text-[var(--fg)]", compact ? "text-[11px]" : "text-[12px]")}
            onClick={onDismiss}
            aria-label="Dismiss"
          >
            Dismiss
          </button>
        ) : null}
      </div>
    </div>
  );
}
