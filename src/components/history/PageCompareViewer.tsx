"use client";

/**
 * The full-size comparison: one changed page, previous against new, big enough to decide by.
 *
 * The strip answers "which pages changed". This answers "what changed on this one", which needs
 * the pages large and needs more than one way of looking at them, because the three common kinds of
 * change are not all visible the same way:
 *
 * - Side by side reads best for layout and for anything you can name - a heading, a chart, a block
 *   that appeared. It is the default because it never lies: both versions are fully visible at once.
 * - Slider is the one that finds small moves. Two pages that look identical side by side snap into
 *   focus when one wipes over the other and a number or a logo jumps.
 * - Fade catches what the other two miss, which is anything that changed in place without changing
 *   shape: a recoloured bar, a swapped photograph with the same crop.
 *
 * Deliberately no highlight boxes yet. Those need a pixel diff and a reflow guard - without the
 * guard, one inserted sentence reflows the page and paints everything below it as changed, which
 * reads as a broken feature rather than a shifted paragraph.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { PageChange } from "@/components/history/PageDiffStrip";

type Mode = "side" | "slider" | "fade";

const MODES: Array<{ id: Mode; label: string; hint: string }> = [
  { id: "side", label: "Side by side", hint: "Both versions at once" },
  { id: "slider", label: "Slider", hint: "Drag to wipe between them" },
  { id: "fade", label: "Fade", hint: "Cross-fade to catch changes in place" },
];

/** "v4" for a real version number, otherwise the caller's word for that side. */
function versionLabel(v: number | null, fallback: string): string {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? `v${Math.floor(v)}` : fallback;
}

/** Shared frame so the two versions line up even when one render is missing. */
function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[120px] items-center justify-center overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel-2,var(--panel))]">
      {children}
    </div>
  );
}

/** Stand-in for a version whose page render was never stored. */
function Missing() {
  return <div className="px-4 py-10 text-xs text-[var(--muted)]">No render stored for this version</div>;
}

/** One changed page at full size, with side-by-side, slider and fade comparisons. */
export default function PageCompareViewer({
  pages,
  index,
  onIndexChange,
  onClose,
  fromVersion,
  toVersion,
}: {
  pages: PageChange[];
  index: number;
  onIndexChange: (next: number) => void;
  onClose: () => void;
  fromVersion: number | null;
  toVersion: number | null;
}) {
  const [mode, setMode] = useState<Mode>("side");
  /** Slider position and fade amount, both 0-100 so one control shape serves both. */
  const [wipe, setWipe] = useState(50);
  const [fade, setFade] = useState(50);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const page = pages[index] ?? null;
  const fromLabel = versionLabel(fromVersion, "previous");
  const toLabel = versionLabel(toVersion, "new");

  const step = useCallback(
    (delta: number) => {
      const next = index + delta;
      if (next >= 0 && next < pages.length) onIndexChange(next);
    },
    [index, pages.length, onIndexChange],
  );

  // Escape closes; arrows walk the changed pages, which is the whole point of opening this on a
  // deck rather than a single page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (e.key === "ArrowRight") return step(1);
      if (e.key === "ArrowLeft") return step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, step]);

  // Focus the panel so the arrow keys work without a click first.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  if (!page) return null;

  const prev = page.previousImageUrl;
  const next = page.newImageUrl;

  return (
    <div className="fixed inset-0 z-[200]" role="dialog" aria-modal="true" aria-label={`Page ${page.pageNumber} comparison`}>
      <button type="button" className="absolute inset-0 bg-black/70 backdrop-blur-sm" aria-label="Close" onClick={onClose} />

      <div
        ref={dialogRef}
        tabIndex={-1}
        className="absolute inset-3 flex flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl outline-none sm:inset-6"
      >
        {/* Header: what you are looking at, how to look at it, and how to leave. */}
        <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-semibold text-[var(--fg)]">Page {page.pageNumber}</span>
              <span className="text-xs text-[var(--muted)]">
                {fromLabel} to {toLabel}
              </span>
              {pages.length > 1 ? (
                <span className="text-xs text-[var(--muted)]">
                  · {index + 1} of {pages.length} changed
                </span>
              ) : null}
            </div>
            {page.summary?.trim() ? (
              <div className="mt-0.5 truncate text-xs text-[var(--muted)]">{page.summary.trim()}</div>
            ) : null}
          </div>

          <div className="flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-0.5">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                title={m.hint}
                onClick={() => setMode(m.id)}
                className={[
                  "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                  mode === m.id
                    ? "bg-[var(--fg)] text-[var(--bg)]"
                    : "text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
                ].join(" ")}
              >
                {m.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[var(--border)] bg-[var(--panel)] px-2.5 py-1 text-[11px] font-medium text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]"
          >
            Close
          </button>
        </div>

        {/* The comparison itself. */}
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {mode === "side" ? (
            <div className="flex h-full flex-col gap-4 lg:flex-row">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">{fromLabel}</div>
                <Frame>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {prev ? <img src={prev} alt={`Page ${page.pageNumber}, ${fromLabel}`} className="block h-auto w-full" /> : <Missing />}
                </Frame>
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">{toLabel}</div>
                <Frame>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {next ? <img src={next} alt={`Page ${page.pageNumber}, ${toLabel}`} className="block h-auto w-full" /> : <Missing />}
                </Frame>
              </div>
            </div>
          ) : null}

          {mode === "slider" && prev && next ? (
            <div className="mx-auto max-w-4xl">
              {/*
                Both images stacked at identical width, the top one clipped by the wipe position.
                `inset-y-0 w-full` on the inner wrapper keeps the clipped image at the container's
                own width, so it does not rescale as the clip narrows.
              */}
              <div className="relative overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel-2,var(--panel))]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={next} alt={`Page ${page.pageNumber}, ${toLabel}`} className="block h-auto w-full" />
                <div className="absolute inset-0 overflow-hidden" style={{ clipPath: `inset(0 ${100 - wipe}% 0 0)` }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={prev} alt={`Page ${page.pageNumber}, ${fromLabel}`} className="block h-full w-full object-cover object-left-top" />
                </div>
                <div className="pointer-events-none absolute inset-y-0 w-px bg-[var(--fg)]/70" style={{ left: `${wipe}%` }} />
              </div>
              <div className="mt-3 flex items-center gap-3">
                <span className="w-16 shrink-0 text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">{fromLabel}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={wipe}
                  onChange={(e) => setWipe(Number(e.target.value))}
                  aria-label="Wipe between versions"
                  className="h-1 w-full cursor-ew-resize accent-[var(--fg)]"
                />
                <span className="w-16 shrink-0 text-right text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">{toLabel}</span>
              </div>
            </div>
          ) : null}

          {mode === "fade" && prev && next ? (
            <div className="mx-auto max-w-4xl">
              <div className="relative overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel-2,var(--panel))]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={prev} alt={`Page ${page.pageNumber}, ${fromLabel}`} className="block h-auto w-full" />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={next}
                  alt={`Page ${page.pageNumber}, ${toLabel}`}
                  className="absolute inset-0 block h-full w-full"
                  style={{ opacity: fade / 100 }}
                />
              </div>
              <div className="mt-3 flex items-center gap-3">
                <span className="w-16 shrink-0 text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">{fromLabel}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={fade}
                  onChange={(e) => setFade(Number(e.target.value))}
                  aria-label="Fade between versions"
                  className="h-1 w-full cursor-ew-resize accent-[var(--fg)]"
                />
                <span className="w-16 shrink-0 text-right text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">{toLabel}</span>
              </div>
            </div>
          ) : null}

          {/* Slider and fade both need two images to have anything to do. */}
          {mode !== "side" && !(prev && next) ? (
            <div className="px-4 py-10 text-center text-xs text-[var(--muted)]">
              Only one version of this page was rendered, so there is nothing to wipe between. Side by side shows what there is.
            </div>
          ) : null}
        </div>

        {/* Walking the changed pages without closing and reopening. */}
        {pages.length > 1 ? (
          <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] px-4 py-2.5">
            <button
              type="button"
              onClick={() => step(-1)}
              disabled={index === 0}
              className="rounded-md border border-[var(--border)] bg-[var(--panel)] px-2.5 py-1 text-[11px] font-medium text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] disabled:opacity-40"
            >
              Previous page
            </button>
            <div className="flex flex-wrap justify-center gap-1">
              {pages.map((p, i) => (
                <button
                  key={p.pageNumber}
                  type="button"
                  onClick={() => onIndexChange(i)}
                  aria-label={`Page ${p.pageNumber}`}
                  className={[
                    "min-w-7 rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums transition-colors",
                    i === index
                      ? "bg-[var(--fg)] text-[var(--bg)]"
                      : "text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
                  ].join(" ")}
                >
                  {p.pageNumber}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => step(1)}
              disabled={index === pages.length - 1}
              className="rounded-md border border-[var(--border)] bg-[var(--panel)] px-2.5 py-1 text-[11px] font-medium text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] disabled:opacity-40"
            >
              Next page
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
