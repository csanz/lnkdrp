"use client";

/**
 * The full-size comparison: one changed page, previous against new, with the changed areas marked.
 *
 * The strip answers "which pages changed". This answers "what changed on this one", which needs the
 * pages large, needs the eye pointed at the right part of them, and needs more than one way of
 * looking, because the common kinds of change are not all visible the same way:
 *
 * - Side by side reads best for layout and for anything you can name - a heading, a chart, a block
 *   that appeared. It is the default because it never lies: both versions are fully visible at once.
 * - Slider finds small moves. Two pages that look identical side by side snap into focus when one
 *   wipes over the other and a number or a logo jumps.
 * - Fade catches what neither of the others does: anything that changed in place without changing
 *   shape, a recoloured bar, a photograph swapped at the same crop.
 *
 * The boxes come from `useDiffRegions`, computed in this browser on the two images already on
 * screen. They cost nothing per compare and exist on every row, including ones whose compare was
 * skipped for credits - a deterministic pixel difference does not need a model to have run.
 *
 * Images load only for the page being looked at. The strip that opens this deliberately shows none.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { PageChange } from "@/components/history/PageDiffStrip";
import { useDiffRegions } from "@/components/history/useDiffRegions";
import type { DiffBox } from "@/lib/history/pageDiffRegions";

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

/**
 * The marks themselves.
 *
 * Coloured by side rather than uniformly, because the two sides are not saying the same thing. On
 * the previous version a mark means "this is what was here"; on the new one it means "this is what
 * is here now". One colour for both made the reader do that inference themselves on every box.
 *
 * The fills are deliberately faint. The mark's job is to move the eye to the region and then get
 * out of its way so the content can be read; a fill strong enough to be the first thing you notice
 * is also strong enough to obscure the words it is pointing at. The ring carries the signal.
 *
 * Red and green together are the classic hazard, so the colour is never the only cue: the side
 * captions name the versions, the legend in the header spells out which side means what, and the
 * two sit in fixed positions, previous left and new right.
 *
 * Coordinates are page fractions, so the same numbers hold at any display size.
 */
function Marks({ boxes, tone }: { boxes: DiffBox[]; tone: "removed" | "added" }) {
  const style =
    tone === "removed"
      ? "bg-rose-500/10 ring-rose-400/80 dark:bg-rose-400/10 dark:ring-rose-400/70"
      : "bg-emerald-500/10 ring-emerald-500/80 dark:bg-emerald-400/10 dark:ring-emerald-400/70";
  return (
    <div className="pointer-events-none absolute inset-0">
      {boxes.map((b, i) => (
        <div
          key={i}
          className={["absolute rounded-[3px] ring-2", style].join(" ")}
          style={{
            left: `${b.x * 100}%`,
            top: `${b.y * 100}%`,
            width: `${b.width * 100}%`,
            height: `${b.height * 100}%`,
          }}
        />
      ))}
    </div>
  );
}

/** One swatch of the legend, so the colours are explained rather than guessed at. */
function Swatch({ tone, children }: { tone: "removed" | "added"; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-[var(--muted)]">
      <span
        className={[
          "inline-block h-2.5 w-2.5 rounded-[2px] ring-2",
          tone === "removed" ? "bg-rose-500/20 ring-rose-400/80" : "bg-emerald-500/20 ring-emerald-500/80",
        ].join(" ")}
      />
      {children}
    </span>
  );
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
  const [showMarks, setShowMarks] = useState(true);
  /** Slider position and fade amount, both 0-100 so one control shape serves both. */
  const [wipe, setWipe] = useState(50);
  const [fade, setFade] = useState(50);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const page = pages[index] ?? null;
  const prev = page?.previousImageUrl ?? null;
  const next = page?.newImageUrl ?? null;
  const fromLabel = versionLabel(fromVersion, "previous");
  const toLabel = versionLabel(toVersion, "new");

  const regions = useDiffRegions(prev, next, showMarks);
  const boxes = regions.status === "done" && !regions.reflowed ? regions.boxes : [];

  const step = useCallback(
    (delta: number) => {
      const target = index + delta;
      if (target >= 0 && target < pages.length) onIndexChange(target);
    },
    [index, pages.length, onIndexChange],
  );

  // Escape closes; arrows walk the changed pages, which is the point of opening this on a deck
  // rather than on a single page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (e.key === "ArrowRight") return step(1);
      if (e.key === "ArrowLeft") return step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, step]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  if (!page) return null;

  /** What the marks are currently saying, in one line, including when they say nothing. */
  const marksNote =
    !showMarks
      ? null
      : regions.status === "working"
        ? "Finding changes…"
        : regions.status === "done" && regions.reflowed
          ? "This page was reworked, so marking regions would cover most of it"
          : regions.status === "done" && !regions.boxes.length
            ? "No visible difference on this page"
            : regions.status === "done"
              ? `${regions.boxes.length} area${regions.boxes.length === 1 ? "" : "s"} changed`
              : null;

  return (
    <div className="fixed inset-0 z-[200]" role="dialog" aria-modal="true" aria-label={`Page ${page.pageNumber} comparison`}>
      <button type="button" className="absolute inset-0 bg-black/70 backdrop-blur-sm" aria-label="Close" onClick={onClose} />

      <div
        ref={dialogRef}
        tabIndex={-1}
        className="absolute inset-3 flex flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl outline-none sm:inset-6"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--border)] px-4 py-3">
          <div className="min-w-[12rem] flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-semibold text-[var(--fg)]">Page {page.pageNumber}</span>
              <span className="text-xs text-[var(--muted)]">
                {fromLabel} to {toLabel}
              </span>
              {pages.length > 1 ? (
                <span className="text-xs text-[var(--muted)]">
                  · {index + 1} of {pages.length} changed
                </span>
              ) : null}
              {marksNote ? <span className="text-xs text-[var(--muted)]">· {marksNote}</span> : null}
            </div>
            {showMarks && boxes.length ? (
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                <Swatch tone="removed">was here in {fromLabel}</Swatch>
                <Swatch tone="added">is here now in {toLabel}</Swatch>
              </div>
            ) : page.summary?.trim() ? (
              <div className="mt-0.5 truncate text-xs text-[var(--muted)]">{page.summary.trim()}</div>
            ) : null}
          </div>

          <button
            type="button"
            onClick={() => setShowMarks((v) => !v)}
            aria-pressed={showMarks}
            title="Mark the areas that differ between the two versions"
            className={[
              "shrink-0 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors",
              showMarks
                ? "border-[var(--fg)]/30 bg-[var(--panel-hover)] text-[var(--fg)]"
                : "border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
            ].join(" ")}
          >
            Highlight changes
          </button>

          <div className="flex shrink-0 items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-0.5">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                title={m.hint}
                onClick={() => setMode(m.id)}
                className={[
                  "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                  mode === m.id ? "bg-[var(--fg)] text-[var(--bg)]" : "text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
                ].join(" ")}
              >
                {m.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--panel)] px-2.5 py-1 text-[11px] font-medium text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]"
          >
            Close
          </button>
        </div>

        {/*
          The scroll container owns the height. Nothing inside claims `h-full`: doing that capped
          the images at the panel height while they kept their natural aspect ratio, and the
          overflow was clipped off the top rather than scrolled to.
        */}
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {mode === "side" ? (
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
              <figure className="m-0 flex min-w-0 flex-1 flex-col gap-1.5">
                <figcaption className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">{fromLabel}</figcaption>
                <div className="relative overflow-hidden rounded-lg border border-[var(--border)] bg-white">
                  {prev ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={prev} alt={`Page ${page.pageNumber}, ${fromLabel}`} className="block h-auto w-full" />
                      {showMarks && boxes.length ? <Marks boxes={boxes} tone="removed" /> : null}
                    </>
                  ) : (
                    <div className="px-4 py-10 text-center text-xs text-[var(--muted)]">No render stored for this version</div>
                  )}
                </div>
              </figure>
              <figure className="m-0 flex min-w-0 flex-1 flex-col gap-1.5">
                <figcaption className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">{toLabel}</figcaption>
                <div className="relative overflow-hidden rounded-lg border border-[var(--border)] bg-white">
                  {next ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={next} alt={`Page ${page.pageNumber}, ${toLabel}`} className="block h-auto w-full" />
                      {showMarks && boxes.length ? <Marks boxes={boxes} tone="added" /> : null}
                    </>
                  ) : (
                    <div className="px-4 py-10 text-center text-xs text-[var(--muted)]">No render stored for this version</div>
                  )}
                </div>
              </figure>
            </div>
          ) : null}

          {mode === "slider" && prev && next ? (
            <div className="mx-auto max-w-4xl">
              <div className="relative overflow-hidden rounded-lg border border-[var(--border)] bg-white">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={next} alt={`Page ${page.pageNumber}, ${toLabel}`} className="block h-auto w-full" />
                <div className="absolute inset-0 overflow-hidden" style={{ clipPath: `inset(0 ${100 - wipe}% 0 0)` }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={prev} alt={`Page ${page.pageNumber}, ${fromLabel}`} className="block h-full w-full object-cover object-left-top" />
                </div>
                {showMarks && boxes.length ? <Marks boxes={boxes} tone="added" /> : null}
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
              <div className="relative overflow-hidden rounded-lg border border-[var(--border)] bg-white">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={prev} alt={`Page ${page.pageNumber}, ${fromLabel}`} className="block h-auto w-full" />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={next} alt={`Page ${page.pageNumber}, ${toLabel}`} className="absolute inset-0 block h-full w-full" style={{ opacity: fade / 100 }} />
                {showMarks && boxes.length ? <Marks boxes={boxes} tone="added" /> : null}
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
                    i === index ? "bg-[var(--fg)] text-[var(--bg)]" : "text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
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
