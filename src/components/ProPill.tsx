/**
 * ProPill — tiny "Pro" badge placed next to controls and links gated behind the Pro plan
 * (revision-history switch, version history links on Free workspaces).
 *
 * With `onClick` it renders as a button (same look, hover state) so a tap can open the upgrade
 * modal; without it, a plain span, safe to nest inside a link. Pro workspaces never render it.
 */
import { cn } from "@/lib/cn";

const BASE =
  "inline-flex shrink-0 items-center rounded-md border border-[var(--border)] bg-[var(--panel)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted-2)]";

/** Small "Pro" pill for controls gated behind the Pro plan. */
export default function ProPill({ className, onClick }: { className?: string; onClick?: () => void }) {
  if (onClick) {
    return (
      <button
        type="button"
        className={cn(
          BASE,
          "hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
          className,
        )}
        title="Pro feature — see what's included"
        aria-label="Pro feature. See what's included in Pro"
        onClick={onClick}
      >
        Pro
      </button>
    );
  }
  return (
    <span className={cn(BASE, className)} title="Pro feature">
      Pro
    </span>
  );
}
