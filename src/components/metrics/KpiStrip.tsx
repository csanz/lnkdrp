/**
 * Headline numbers for the selected link and range: people, total time, how many reached the last
 * page (Pro), when it was last opened, and downloads when they apply.
 */
"use client";

import { useState } from "react";
import { formatCountOf, formatDwell, formatRelative } from "@/lib/analytics/reading/format";
import type { ReadingResponse } from "@/lib/analytics/reading/types";

export const tileLabelClass = "text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]";

/** Small ⓘ that shows its text on hover (title) and toggles it inline on tap. */
export function InfoTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        title={text}
        aria-label={text}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full align-middle text-[11px] leading-none text-[var(--muted-2)] hover:text-[var(--fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      >
        ⓘ
      </button>
      {open ? <span className="mt-1 block text-[11px] font-normal normal-case tracking-normal text-[var(--muted)]">{text}</span> : null}
    </>
  );
}

type Tile = { key: string; label: string; info?: string; value: string; sub?: string | null };

export type KpiStripProps = {
  reading: ReadingResponse | null;
  loading: boolean;
  error: boolean;
  /** Downloads in range when the tile applies; null hides the tile. */
  downloads: number | null;
  now: number;
};

/** KPI tiles. */
export default function KpiStrip({ reading, loading, error, downloads, now }: KpiStripProps) {
  const deep = reading?.tier === "deep";

  if (loading && !reading) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-[72px] animate-pulse rounded-2xl bg-[var(--panel-hover)]" />
        ))}
      </div>
    );
  }

  const r = error ? null : reading;
  let lastOpened = "—";
  let lastOpenedSub: string | null = null;
  if (r?.lastOpenedAt) lastOpened = formatRelative(r.lastOpenedAt, now);
  else if (r?.lastOpenedAtAllTime) {
    lastOpened = formatRelative(r.lastOpenedAtAllTime, now);
    lastOpenedSub = "before this range";
  }

  const tiles: Tile[] = [
    { key: "people", label: "People", info: "Someone who opened two links counts once per link.", value: r ? String(r.people) : "—" },
    {
      key: "time",
      label: "Total time",
      info: "Time people spent with it open during this range.",
      value: r ? formatDwell(r.totalMs) : "—",
      sub: deep && r?.totals?.medianTotalMs != null ? `typical ${formatDwell(r.totals.medianTotalMs)} per person` : null,
    },
  ];
  if (deep && r) {
    tiles.push({
      key: "end",
      label: "Reached the last page",
      value: (r.peopleWithDetail ?? 0) > 0 ? formatCountOf(r.totals?.reachedEnd ?? 0, r.peopleWithDetail ?? 0) : "—",
    });
  }
  tiles.push({ key: "last", label: "Last opened", value: lastOpened, sub: lastOpenedSub });
  if (downloads !== null) tiles.push({ key: "downloads", label: "Downloads", value: String(downloads) });

  const cols = tiles.length >= 5 ? "grid-cols-2 sm:grid-cols-4 lg:grid-cols-5" : "grid-cols-2 sm:grid-cols-4";
  // With three tiles the last one spans two columns, so neither the 2- nor the 4-column grid leaves a hole.
  const spanLast = tiles.length === 3;

  return (
    <div data-kpis className={`grid gap-3 ${cols}`}>
      {tiles.map((t, i) => (
        <div
          key={t.key}
          data-kpi={t.key}
          className={`min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-4${spanLast && i === tiles.length - 1 ? " col-span-2" : ""}`}
        >
          <div className={tileLabelClass}>
            {t.label} {t.info ? <InfoTip text={t.info} /> : null}
          </div>
          <div data-kpi-value className="mt-1 truncate text-2xl font-semibold tabular-nums text-[var(--fg)]">
            {t.value}
          </div>
          {t.sub ? <div className="mt-0.5 truncate text-[12px] text-[var(--muted)]">{t.sub}</div> : null}
        </div>
      ))}
    </div>
  );
}
