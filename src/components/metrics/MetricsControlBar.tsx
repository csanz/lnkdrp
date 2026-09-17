/**
 * Sticky control bar for the metrics page: which link, and which range. Free gets one range plus
 * an entry that opens the upgrade modal instead of changing the range.
 */
"use client";

import Select from "@/components/ui/Select";
import type { LinkRow, ReadingTier } from "@/lib/analytics/reading/types";
import { UPSELL_INLINE_LABELS } from "@/lib/client/upsellCopy";
import type { MetricsDays } from "./metricsUrlState";

const DEEP_RANGES: Array<{ days: MetricsDays; label: string }> = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
  { days: 365, label: "Last 12 months" },
];

const MORE_HISTORY = "more";

export type MetricsControlBarProps = {
  links: LinkRow[] | null;
  shareId: string | null;
  days: MetricsDays;
  tier: ReadingTier | null;
  onShareId: (shareId: string | null) => void;
  onDays: (days: MetricsDays) => void;
  onMoreHistory: () => void;
  /** The section jump chips: right-aligned after the selects from 1024px, a second row below that. */
  children?: React.ReactNode;
};

function linkOptionLabel(l: LinkRow): string {
  if (l.people <= 0) return l.label;
  return `${l.label} · ${l.people} ${l.people === 1 ? "person" : "people"}`;
}

/** Link and range selects. */
export default function MetricsControlBar({ links, shareId, days, tier, onShareId, onDays, onMoreHistory, children }: MetricsControlBarProps) {
  const options = (links ?? []).filter((l) => l.status !== "deleted");
  const selectedKnown = !shareId || options.some((l) => l.shareId === shareId);

  return (
    <div data-control-bar className="sticky top-0 z-10 bg-[var(--bg)]/95 py-2 backdrop-blur-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Link"
          variant="panel"
          className="h-11 min-w-0 flex-1 truncate sm:h-10 sm:max-w-[320px] sm:flex-none"
          value={shareId ?? ""}
          onChange={(e) => onShareId(e.target.value || null)}
        >
          <option value="">All links</option>
          {!selectedKnown && shareId ? <option value={shareId}>Selected link</option> : null}
          {options.map((l) => (
            <option key={l.shareId} value={l.shareId}>
              {linkOptionLabel(l)}
            </option>
          ))}
        </Select>
        {tier === "basic" ? (
          <Select
            aria-label="Range"
            variant="panel"
            className="h-11 min-w-0 flex-1 sm:h-10 sm:flex-none"
            value="7"
            onChange={(e) => {
              if (e.target.value === MORE_HISTORY) onMoreHistory();
            }}
          >
            <option value="7">Last 7 days</option>
            <option value={MORE_HISTORY}>{UPSELL_INLINE_LABELS.analytics_more_history}</option>
          </Select>
        ) : (
          <Select
            aria-label="Range"
            variant="panel"
            className="h-11 min-w-0 flex-1 sm:h-10 sm:flex-none"
            value={String(days)}
            onChange={(e) => onDays(Number(e.target.value) as MetricsDays)}
          >
            {DEEP_RANGES.map((r) => (
              <option key={r.days} value={r.days}>
                {r.label}
              </option>
            ))}
          </Select>
        )}
        {children ? <div className="w-full min-w-0 lg:ml-auto lg:w-auto">{children}</div> : null}
      </div>
    </div>
  );
}
