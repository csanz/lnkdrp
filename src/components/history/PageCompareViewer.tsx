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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { PageChange } from "@/components/history/PageDiffStrip";
import { useDiffRegions } from "@/components/history/useDiffRegions";
import type { DiffBox } from "@/lib/history/pageDiffRegions";
import { diffPresentation } from "@/lib/history/wordDiff";
import { isReadableText } from "@/lib/history/textReadability";

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
function Marks({ boxes, tone, notes }: { boxes: DiffBox[]; tone: "removed" | "added"; notes?: string[] }) {
  const style =
    tone === "removed"
      ? "bg-rose-500/10 ring-rose-400/80 dark:bg-rose-400/10 dark:ring-rose-400/70"
      : "bg-emerald-500/10 ring-emerald-500/80 dark:bg-emerald-400/10 dark:ring-emerald-400/70";
  const badge = tone === "removed" ? "bg-rose-500 text-white" : "bg-emerald-600 text-white";
  return (
    <div className="pointer-events-none absolute inset-0">
      {boxes.map((b, i) => {
        const note = notes?.[i]?.trim() || "";
        /**
         * Captions sit under their mark, or above it when the mark is near the foot of the page
         * and there is no room below. Anchored to the box's own left edge, so the caption reads as
         * belonging to that mark rather than to the page.
         */
        const below = b.y + b.height < 0.82;
        return (
          <div
            key={i}
            className={["absolute rounded-[3px] ring-2", style].join(" ")}
            style={{
              left: `${b.x * 100}%`,
              top: `${b.y * 100}%`,
              width: `${b.width * 100}%`,
              height: `${b.height * 100}%`,
            }}
          >
            {/* Numbered only when there is more than one: a lone mark needs no label to be found. */}
            {boxes.length > 1 ? (
              <span
                className={[
                  "absolute -left-1.5 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold leading-none",
                  badge,
                ].join(" ")}
              >
                {i + 1}
              </span>
            ) : null}

            {note ? (
              <span
                className="absolute left-0 w-[min(30rem,60vw)] max-w-[100vw]"
                style={below ? { top: "calc(100% + 6px)" } : { bottom: "calc(100% + 6px)" }}
              >
                <span className="inline-flex items-start gap-1.5 rounded-md border border-[var(--border)] bg-[var(--panel)]/95 px-2 py-1 text-[10px] leading-snug text-[var(--fg)] shadow-md backdrop-blur-sm">
                  {boxes.length > 1 ? (
                    <span
                      className={["mt-px flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[8px] font-bold leading-none", badge].join(" ")}
                    >
                      {i + 1}
                    </span>
                  ) : null}
                  <span>{note}</span>
                </span>
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** One swatch of the legend, so the colours are explained rather than guessed at. */
function Swatch({ tone, children }: { tone: "removed" | "added"; children: React.ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-[var(--muted)]">
      <span
        className={[
          "inline-block h-2.5 w-2.5 shrink-0 rounded-[2px] ring-1",
          tone === "removed" ? "bg-rose-500/20 ring-rose-400/80" : "bg-emerald-500/20 ring-emerald-500/80",
        ].join(" ")}
      />
      {children}
    </span>
  );
}

/**
 * What the model said about this page, laid over the version it describes.
 *
 * The boxes are geometry and the note is language, and each is only good at its own half: a pixel
 * difference knows exactly where something moved and nothing about what it means, while the model
 * reads the page well and places things on it badly - which is why it is never asked for
 * coordinates. Pairing them keeps each to what it can be trusted for.
 *
 * On the new version only. It was on both, and on the previous page it was describing something
 * that had not happened yet - "Added 'the next 18 months' to timeline" stamped over a page whose
 * timeline still said something else.
 */
function PageNote({ text }: { text: string }) {
  return (
    <div className="pointer-events-none absolute inset-x-3 bottom-3 flex justify-center">
      <div className="max-w-xl rounded-lg border border-[var(--border)] bg-[var(--panel)]/95 px-3 py-2 text-[11px] leading-relaxed text-[var(--fg)] shadow-lg backdrop-blur-sm">
        {text}
      </div>
    </div>
  );
}

/** What kind of change this page carries, stated plainly. See `pageChangeKind`. */
function KindChip({ kind }: { kind: "added" | "removed" | "replaced" }) {
  const label = kind === "added" ? "Added" : kind === "removed" ? "Removed" : "Replaced";
  const style =
    kind === "added"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : kind === "removed"
        ? "bg-rose-500/15 text-rose-700 dark:text-rose-300"
        : "bg-[var(--panel-hover)] text-[var(--fg)]";
  return <span className={["rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide", style].join(" ")}>{label}</span>;
}

/**
 * The words that changed, which is what a box around a rewritten paragraph cannot show.
 *
 * Two shapes, chosen by how much moved. A few edits read best marked in place, inside the sentence
 * they belong to. A rewrite does not: common little words keep matching and shatter the passage
 * into dozens of fragments, every one correct and the whole unreadable, so both versions are shown
 * whole instead. See `diffPresentation`.
 *
 * The colours are the ones on the page marks, so red and green mean the same thing throughout.
 */
function WordDiff({
  previous,
  next,
  previousWording,
  newWording,
}: {
  previous: string;
  next: string;
  previousWording: string | null;
  newWording: string | null;
}) {
  /**
   * When the PDF's own text layer is unusable, use what the model read off the page.
   *
   * A PDF stores glyph indices, and recovering characters needs the font's ToUnicode map; fonts
   * subset without one are routine, and the extractor then returns the indices - valid Unicode
   * that renders as symbols. An earlier version of this said so, in those words, which was an
   * explanation of our problem rather than an answer to the reader's. The model is looking at the
   * page image regardless, so it reads the wording instead and that is what gets shown.
   */
  const extractionUnusable = !isReadableText(previous) || !isReadableText(next);
  const readFromPage = extractionUnusable && Boolean(previousWording || newWording);

  if (readFromPage) {
    return (
      <div className="space-y-2">
        <div className="text-[11px] text-[var(--muted)]">Read from the page, because this PDF stores its text as shapes.</div>
        <div className="grid gap-2 lg:grid-cols-2">
          <p className="m-0 rounded-md bg-rose-500/10 px-3 py-2 text-xs leading-relaxed text-rose-700 dark:text-rose-200">
            {previousWording?.trim() || "(nothing here before)"}
          </p>
          <p className="m-0 rounded-md bg-emerald-500/10 px-3 py-2 text-xs leading-relaxed text-emerald-800 dark:text-emerald-200">
            {newWording?.trim() || "(nothing here now)"}
          </p>
        </div>
      </div>
    );
  }

  // No usable text layer and nothing read off the page either: say nothing rather than print
  // symbols or apologise. The comparison above is the answer in that case.
  if (extractionUnusable) return null;

  const result = diffPresentation(previous, next);

  if (result.mode === "identical") {
    return <div className="text-[11px] text-[var(--muted)]">The words on this page are identical; any difference is in the artwork.</div>;
  }

  if (result.mode === "blocks") {
    return (
      <div className="space-y-2">
        <div className="text-[11px] text-[var(--muted)]">
          This page was rewritten rather than edited ({Math.round(result.changed * 100)}% of the wording moved), so both versions
          are shown whole.
        </div>
        <div className="grid gap-2 lg:grid-cols-2">
          <p className="m-0 rounded-md bg-rose-500/10 px-3 py-2 text-xs leading-relaxed text-rose-700 dark:text-rose-200">
            {result.previous || "(no text on this page)"}
          </p>
          <p className="m-0 rounded-md bg-emerald-500/10 px-3 py-2 text-xs leading-relaxed text-emerald-800 dark:text-emerald-200">
            {result.next || "(no text on this page)"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <p className="m-0 whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--muted)]">
      {result.spans.map((sp, i) =>
        sp.type === "same" ? (
          <span key={i}>{sp.text}</span>
        ) : sp.type === "removed" ? (
          <span key={i} className="rounded-[2px] bg-rose-500/15 text-rose-600 line-through decoration-rose-500/50 dark:text-rose-300">
            {sp.text}
          </span>
        ) : (
          <span key={i} className="rounded-[2px] bg-emerald-500/15 font-medium text-emerald-700 dark:text-emerald-300">
            {sp.text}
          </span>
        ),
      )}
    </p>
  );
}

/**
 * A floating page arrow, over the pages rather than under them.
 *
 * The same control the share viewer puts on a document, for the same reason: stepping through
 * pages is what you do constantly in here, and a bar at the foot of a tall scrolling panel means
 * scrolling away from the thing you are reading to reach it, then back. Visible at rest so it is
 * not a hover secret, dimmed rather than hidden at the ends so the position stays legible.
 */
function PageArrow({ side, disabled, onClick }: { side: "left" | "right"; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={side === "left" ? "Previous changed page" : "Next changed page"}
      title={side === "left" ? "Previous changed page (←)" : "Next changed page (→)"}
      onClick={onClick}
      disabled={disabled}
      className={[
        "pointer-events-auto absolute top-1/2 z-10 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full",
        "bg-[var(--panel)]/90 text-[var(--fg)] shadow-xl ring-1 ring-[var(--border)] backdrop-blur-sm transition",
        "hover:bg-[var(--panel-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--fg)]",
        "disabled:pointer-events-none disabled:opacity-25",
        side === "left" ? "left-2 sm:left-4" : "right-2 sm:right-4",
      ].join(" ")}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d={side === "left" ? "M15 6L9 12L15 18" : "M9 6L15 12L9 18"}
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/** Two letters from a name, for the avatar. Falls back to one, then to a neutral mark. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Who made this change, against the change itself.
 *
 * The row header already names them, but by the time somebody is looking at a page in here the
 * header is behind a modal and two clicks away, and "who changed this" is most often asked exactly
 * when looking at the thing that changed. It sits on the new version only: the previous page is
 * what was there before this person touched it.
 */
function AuthorBadge({ name, when }: { name: string; when: string | null }) {
  return (
    <div
      className="pointer-events-none absolute right-3 top-3 flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--panel)]/95 py-1 pl-1 pr-2.5 shadow-lg backdrop-blur-sm"
      title={when ? `Replaced by ${name}, ${when}` : `Replaced by ${name}`}
    >
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--fg)] text-[10px] font-semibold text-[var(--bg)]">
        {initials(name)}
      </span>
      <span className="text-[11px] font-medium text-[var(--fg)]">{name}</span>
      {when ? <span className="text-[11px] text-[var(--muted)]">{when}</span> : null}
    </div>
  );
}

/** One changed page at full size, with side-by-side, slider and fade comparisons. */
export default function PageCompareViewer({
  pages,
  index,
  onIndexChange,
  onClose,
  totalPages,
  fromVersion,
  toVersion,
  authorName,
  changedAt,
}: {
  pages: PageChange[];
  index: number;
  onIndexChange: (next: number) => void;
  onClose: () => void;
  totalPages: number | null;
  fromVersion: number | null;
  toVersion: number | null;
  authorName: string | null;
  changedAt: string | null;
}) {
  const [mode, setMode] = useState<Mode>("side");
  const [showMarks, setShowMarks] = useState(true);
  const [showNotes, setShowNotes] = useState(true);
  /** Slider position and fade amount, both 0-100 so one control shape serves both. */
  const [wipe, setWipe] = useState(50);
  const [fade, setFade] = useState(50);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  /** Portalled, so mount before touching `document`. */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const page = pages[index] ?? null;
  const prev = page?.previousImageUrl ?? null;
  const next = page?.newImageUrl ?? null;
  const fromLabel = versionLabel(fromVersion, "previous");
  const toLabel = versionLabel(toVersion, "new");

  /**
   * Every page of the deck, each carrying the index of its comparison when it has one.
   *
   * Falls back to the changed pages alone when the deck's length is unknown - rows written before
   * the page count was carried through - rather than inventing a total.
   */
  const railPages = useMemo(() => {
    const byPage = new Map(pages.map((p, i) => [p.pageNumber, i]));
    const highest = pages.reduce((m, p) => Math.max(m, p.pageNumber), 0);
    const count = typeof totalPages === "number" && totalPages >= highest ? totalPages : highest;
    if (!count) return [];
    return Array.from({ length: count }, (_, i) => ({ pageNumber: i + 1, changedIndex: byPage.get(i + 1) ?? null }));
  }, [pages, totalPages]);

  /** The deck's length, only when we actually know it rather than inferring it from the edits. */
  const railTotal = typeof totalPages === "number" && totalPages > 0 ? totalPages : null;

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

  // Keep the current tick visible: on a 50-page deck the active page is otherwise off the end of
  // the rail after a few presses of the arrow key.
  useEffect(() => {
    railRef.current?.querySelector('[data-active="1"]')?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [index]);

  if (!page) return null;

  const note = page.summary?.trim() || "";

  /**
   * Is there anything to put in the text panel at all?
   *
   * Either a readable text layer on both sides, or wording the model read off the page when the
   * layer was unusable. Neither means no panel, rather than a panel explaining its own absence.
   */
  const hasWords =
    Boolean(page.previousWording || page.newWording) ||
    ((page.previousText || page.newText) && isReadableText(page.previousText) && isReadableText(page.newText));


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

  if (!mounted) return null;

  /**
   * Through a portal to <body>, above the dialog that opened it.
   *
   * `position: fixed` is relative to the nearest ancestor with a transform, filter or containment,
   * and this is opened from inside the recipient's history panel - which is itself a portalled
   * dialog at the same stacking level. Rendered in place it appeared *behind* that panel. The
   * portal takes it out of the tree and the higher z-index puts it in front, so closing it returns
   * to the panel rather than revealing it.
   */
  return createPortal(
    <div className="fixed inset-0 z-[300]" role="dialog" aria-modal="true" aria-label={`Page ${page.pageNumber} comparison`}>
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
              {page.changeKind ? <KindChip kind={page.changeKind} /> : null}
            </div>
            {/*
              One second line, always present and always one line tall.

              It used to swap a legend for a summary and carry `marksNote` up into the title row,
              so toggling the highlights changed the header's height and the pages below jumped.
              A control that moves what you are looking at is worse than the thing it controls:
              nothing here may change the layout, only its contents.
            */}
            {/*
              `overflow-hidden` belongs on the text, not the row: the swatches carry a 2px ring that
              sits outside their box, and the first one lost its left edge to the clip.
            */}
            <div className="mt-0.5 flex h-4 items-center gap-x-3 whitespace-nowrap pl-0.5">
              {showMarks && boxes.length ? (
                <>
                  <Swatch tone="removed">was here in {fromLabel}</Swatch>
                  <Swatch tone="added">is here now in {toLabel}</Swatch>
                  {marksNote ? <span className="truncate text-[11px] text-[var(--muted)]">· {marksNote}</span> : null}
                </>
              ) : (
                <span className="truncate text-xs text-[var(--muted)]">{marksNote || page.summary?.trim() || ""}</span>
              )}
            </div>
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
            Highlight areas
          </button>

          {page?.summary?.trim() ? (
            <button
              type="button"
              onClick={() => setShowNotes((v) => !v)}
              aria-pressed={showNotes}
              title="What the AI compare said about this page, laid over both versions"
              className={[
                "shrink-0 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors",
                showNotes
                  ? "border-[var(--fg)]/30 bg-[var(--panel-hover)] text-[var(--fg)]"
                  : "border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
              ].join(" ")}
            >
              AI notes
            </button>
          ) : null}

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
        {/*
          The arrows are siblings of the scroll area, not children of it: inside, an absolutely
          positioned element scrolls with the content and slides off the top of a tall page.
        */}
        <div className="relative min-h-0 flex-1">
          {pages.length > 1 ? (
            <>
              <PageArrow side="left" disabled={index === 0} onClick={() => step(-1)} />
              <PageArrow side="right" disabled={index === pages.length - 1} onClick={() => step(1)} />
            </>
          ) : null}
          <div className="h-full overflow-auto p-4">
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
                      {showMarks && boxes.length ? <Marks boxes={boxes} tone="added" notes={showNotes ? page.regionNotes : undefined} /> : null}
                      {authorName ? <AuthorBadge name={authorName} when={changedAt} /> : null}
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
                {showMarks && boxes.length ? <Marks boxes={boxes} tone="added" notes={showNotes ? page.regionNotes : undefined} /> : null}
                {authorName ? <AuthorBadge name={authorName} when={changedAt} /> : null}
                {showNotes && note ? <PageNote text={note} /> : null}
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
                {showMarks && boxes.length ? <Marks boxes={boxes} tone="added" notes={showNotes ? page.regionNotes : undefined} /> : null}
                {authorName ? <AuthorBadge name={authorName} when={changedAt} /> : null}
                {showNotes && note ? <PageNote text={note} /> : null}
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

          {/*
            The words themselves, under the pages.
            A box around a rewritten paragraph says only "this block changed"; this says which
            words, which is the question the reader actually arrived with. Empty on rows written
            before the per-page text was stored, and it simply does not render there.
          */}
          {hasWords ? (
            <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3">
              <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">Text on this page</span>
                <Swatch tone="removed">before</Swatch>
                <Swatch tone="added">now</Swatch>
              </div>
              <WordDiff
                previous={page.previousText}
                next={page.newText}
                previousWording={page.previousWording}
                newWording={page.newWording}
              />
            </div>
          ) : null}

          {/* Slider and fade both need two images to have anything to do. */}
          {mode !== "side" && !(prev && next) ? (
            <div className="px-4 py-10 text-center text-xs text-[var(--muted)]">
              Only one version of this page was rendered, so there is nothing to wipe between. Side by side shows what there is.
            </div>
          ) : null}
          </div>
        </div>

        {/*
          The rail: the comparisons, against the shape of the deck.

          Two things are true at once and the first draft only told one of them. Every page of the
          deck matters for orientation - a reader cannot otherwise see that the edits cluster at the
          front, or that eleven pages were appended - but only the changed pages have a comparison
          to open. Numbering all eighteen made the eleven inert ones look like entries that were
          missing something, and the owner's reaction was to ask why pages that do not exist were
          listed. They do exist; they simply have nothing to show.

          So changed pages are numbered chips you can click, and the rest are unnumbered ticks: the
          deck's shape stays visible, and nothing inert pretends to be a destination. The row scrolls
          on its own axis rather than wrapping, and the active chip is scrolled into view when it
          moves, so a 50-page deck behaves the same as this one.
        */}
        {pages.length > 0 ? (
          <div className="flex items-center gap-3 border-t border-[var(--border)] px-4 py-2.5">
            <div ref={railRef} className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1">
              {railPages.map((rp) =>
                rp.changedIndex === null ? (
                  <span
                    key={rp.pageNumber}
                    title={`Page ${rp.pageNumber} · unchanged`}
                    aria-hidden="true"
                    className="h-1 w-1 shrink-0 rounded-full bg-[var(--border)]"
                  />
                ) : (
                  <button
                    key={rp.pageNumber}
                    type="button"
                    data-active={rp.changedIndex === index ? "1" : undefined}
                    onClick={() => onIndexChange(rp.changedIndex as number)}
                    aria-label={`Compare page ${rp.pageNumber}`}
                    aria-current={rp.changedIndex === index ? "true" : undefined}
                    title={`Page ${rp.pageNumber} · changed`}
                    className={[
                      "shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums transition-colors",
                      rp.changedIndex === index
                        ? "bg-[var(--fg)] text-[var(--bg)]"
                        : "text-emerald-600 hover:bg-[var(--panel-hover)] dark:text-emerald-400",
                    ].join(" ")}
                  >
                    {rp.pageNumber}
                  </button>
                ),
              )}
            </div>

            <span className="shrink-0 text-[11px] text-[var(--muted)]">
              {railTotal ? `${pages.length} of ${railTotal} pages changed` : `${pages.length} changed`}
            </span>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
