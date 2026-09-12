/**
 * ProPill — tiny "Pro" badge placed next to controls and links gated behind the Pro plan
 * (revision-history switch, version history links on Free workspaces).
 */
import { cn } from "@/lib/cn";

/** Small "Pro" pill for controls gated behind the Pro plan. */
export default function ProPill({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-md border border-[var(--border)] bg-[var(--panel)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted-2)]",
        className,
      )}
      title="Pro feature"
    >
      Pro
    </span>
  );
}
