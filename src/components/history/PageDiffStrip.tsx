"use client";

/**
 * The pages that changed, previous beside new, with a way into the full-size comparison.
 *
 * Every compare has stored these two URLs per changed page since the field was added - the schema
 * comment on `DocChange.pagesThatChanged` literally says "for visual diffs in history UIs" - and
 * nothing ever rendered them. The list API mapped them away one line before returning, and the
 * history page had no field for them, so the owner's own history showed less than the recipient's
 * viewer did. Nothing here is computed: these are the same images the compare already paid to look
 * at, which is why this answers "what changed" at no per-compare cost.
 *
 * The strip's job is only to say *which* pages and let you get to one fast. Deciding what actually
 * changed on a page needs it large, which is `PageCompareViewer`.
 */
import { useState } from "react";

import PageCompareViewer from "@/components/history/PageCompareViewer";

export type PageChange = {
  pageNumber: number;
  summary: string;
  previousImageUrl: string | null;
  newImageUrl: string | null;
  /** The perceptual verdict. Null when neither version carried a fingerprint (older uploads). */
  imageChanged: boolean | null;
};

/**
 * Pairs past this many load only when scrolled to.
 *
 * A compare can list up to thirty pages and each is two full-size renders, so an expanded row could
 * otherwise pull sixty images at once on a page nobody has scrolled yet.
 */
const EAGER_PAGES = 4;

/** "v4" for a real version number, otherwise the caller's word for that side. */
function versionLabel(v: number | null, fallback: string): string {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? `v${Math.floor(v)}` : fallback;
}

/** The changed pages for one version, each rendered previous beside new. */
export default function PageDiffStrip({
  pages,
  changedPageCount,
  fromVersion,
  toVersion,
}: {
  pages: PageChange[];
  /** Total pages that changed, against the ones listed. Null on rows written before it was stored. */
  changedPageCount: number | null;
  fromVersion: number | null;
  toVersion: number | null;
}) {
  const [openAt, setOpenAt] = useState<number | null>(null);

  // Nothing to show rather than an empty frame: a compare that listed no pages, or a row old
  // enough that `attachPageContext` never populated the URLs.
  const withImages = pages.filter((p) => p.previousImageUrl || p.newImageUrl);
  if (!withImages.length) return null;

  const fromLabel = versionLabel(fromVersion, "previous");
  const toLabel = versionLabel(toVersion, "new");

  /**
   * "3 of 34 pages changed", when the two differ.
   *
   * The compare caps how many pages it looks at, so a heavily edited deck lists a handful and used
   * to give no sign the rest existed. Saying only "3 pages changed" there is wrong.
   */
  const shown = withImages.length;
  const total = typeof changedPageCount === "number" && changedPageCount > shown ? changedPageCount : null;

  return (
    <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--panel)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-[var(--fg)]">
            {total ? `${shown} of ${total} pages changed` : `${shown} page${shown === 1 ? "" : "s"} changed`}
          </div>
          <div className="mt-0.5 text-[11px] text-[var(--muted)]">
            {fromLabel} on the left, {toLabel} on the right. Click any page to compare it full size.
          </div>
        </div>
        {/*
          The primary way in. The thumbnails below are small by necessity - a 16:9 slide at strip
          width is about 250px across, which answers "did this page change" and nothing else.
        */}
        <button
          type="button"
          onClick={() => setOpenAt(0)}
          className="rounded-md bg-[var(--fg)] px-3 py-1.5 text-[11px] font-semibold text-[var(--bg)] transition-opacity hover:opacity-85"
        >
          Compare full size
        </button>
      </div>

      <div className="space-y-3 p-3">
        {withImages.map((p, idx) => (
          <button
            key={p.pageNumber}
            type="button"
            onClick={() => setOpenAt(idx)}
            aria-label={`Compare page ${p.pageNumber} full size`}
            className="block w-full rounded-lg border border-transparent p-2 text-left transition-colors hover:border-[var(--border)] hover:bg-[var(--panel-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--fg)]"
          >
            <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-xs font-semibold text-[var(--fg)]">Page {p.pageNumber}</span>
              {/*
                Only worth saying when it is true. `imageChanged` is null on uploads predating the
                perceptual fingerprint, and "no" there would be a claim the data cannot support.
              */}
              {p.imageChanged === true ? (
                <span className="rounded-md bg-[var(--panel-hover)] px-1.5 py-0.5 text-[11px] text-[var(--muted-2)]">Artwork changed</span>
              ) : null}
              {p.summary?.trim() ? <span className="text-[11px] text-[var(--muted)]">{p.summary.trim()}</span> : null}
            </div>

            <div className="flex items-stretch gap-2">
              {[
                { url: p.previousImageUrl, label: fromLabel },
                { url: p.newImageUrl, label: toLabel },
              ].map((side) => (
                <figure key={side.label} className="m-0 min-w-0 flex-1">
                  <figcaption className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">{side.label}</figcaption>
                  {side.url ? (
                    <div className="overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg)]">
                      {/* Plain img: these are Blob URLs outside the next/image remote allowlist. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={side.url}
                        alt={`Page ${p.pageNumber}, ${side.label}`}
                        loading={idx < EAGER_PAGES ? "eager" : "lazy"}
                        decoding="async"
                        className="block h-auto w-full"
                      />
                    </div>
                  ) : (
                    <div className="flex aspect-[4/3] items-center justify-center rounded-md border border-dashed border-[var(--border)] bg-[var(--bg)] text-[10px] text-[var(--muted)]">
                      Not rendered
                    </div>
                  )}
                </figure>
              ))}
            </div>
          </button>
        ))}
      </div>

      {openAt !== null ? (
        <PageCompareViewer
          pages={withImages}
          index={Math.min(openAt, withImages.length - 1)}
          onIndexChange={setOpenAt}
          onClose={() => setOpenAt(null)}
          fromVersion={fromVersion}
          toVersion={toVersion}
        />
      ) : null}
    </div>
  );
}
