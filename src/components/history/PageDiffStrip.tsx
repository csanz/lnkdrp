"use client";

/**
 * Which pages changed, and the way in to comparing one.
 *
 * Every compare has stored both page renders per changed page since the field was added - the
 * schema comment on `DocChange.pagesThatChanged` says "for visual diffs in history UIs" - and
 * nothing rendered them: the list API mapped them away one line before returning and the history
 * client had no field for them. So the owner's own history showed less about a change than the
 * recipient's viewer did.
 *
 * This strip deliberately loads **no images**. An expanded row can list up to thirty changed pages,
 * and showing each as a pair meant sixty full-size renders pulled into a list somebody is scrolling
 * past - a page of thumbnails too small to decide anything by, paid for in bandwidth on every
 * expand. The pages themselves belong in `PageCompareViewer`, which loads the two renders for the
 * one page you asked to see.
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
  /** This page's text in each version, for the word diff. Empty on rows written before it was stored. */
  previousText: string;
  newText: string;
  /** The same before and after, read off the images by the model, for pages with no usable text layer. */
  previousWording: string | null;
  newWording: string | null;
};

/** "v4" for a real version number, otherwise the caller's word for that side. */
function versionLabel(v: number | null, fallback: string): string {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? `v${Math.floor(v)}` : fallback;
}

/** The changed pages for one version, as a light list that opens the full-size comparison. */
export default function PageDiffStrip({
  pages,
  changedPageCount,
  totalPages,
  fromVersion,
  toVersion,
  authorName,
  changedAt,
}: {
  pages: PageChange[];
  /** Total pages that changed, against the ones listed. Null on rows written before it was stored. */
  changedPageCount: number | null;
  /** Pages in the new version, so the viewer's rail can show the deck rather than only the edits. */
  totalPages: number | null;
  fromVersion: number | null;
  toVersion: number | null;
  /** Who replaced the file, shown against the change itself rather than only in the row header. */
  authorName: string | null;
  changedAt: string | null;
}) {
  const [openAt, setOpenAt] = useState<number | null>(null);

  // Rows old enough that `attachPageContext` never populated the URLs have nothing to open.
  const withImages = pages.filter((p) => p.previousImageUrl || p.newImageUrl);
  if (!withImages.length) return null;

  const fromLabel = versionLabel(fromVersion, "previous");
  const toLabel = versionLabel(toVersion, "new");

  /**
   * "7 of 18 pages changed", when the two differ.
   *
   * The compare caps how many pages it looks at, so a heavily edited deck lists a handful and used
   * to give no sign the rest existed. Saying only "7 pages changed" there is wrong.
   */
  const shown = withImages.length;
  const total = typeof changedPageCount === "number" && changedPageCount > shown ? changedPageCount : null;

  return (
    <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--panel)]">
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-[var(--fg)]">
            {total ? `${shown} of ${total} pages changed` : `${shown} page${shown === 1 ? "" : "s"} changed`}
          </div>
          <div className="mt-0.5 text-[11px] text-[var(--muted)]">
            {fromLabel} against {toLabel}, with the changed areas marked.
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpenAt(0)}
          className="shrink-0 rounded-md bg-[var(--fg)] px-3 py-1.5 text-[11px] font-semibold text-[var(--bg)] transition-opacity hover:opacity-85"
        >
          Compare full size
        </button>
      </div>

      {/* One chip per changed page. Cheap, scannable, and each one opens the viewer on that page. */}
      <div className="flex flex-wrap gap-1.5 border-t border-[var(--border)] px-3 py-2.5">
        {withImages.map((p, idx) => (
          <button
            key={p.pageNumber}
            type="button"
            onClick={() => setOpenAt(idx)}
            title={p.summary?.trim() || `Compare page ${p.pageNumber}`}
            className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[11px] font-medium tabular-nums text-[var(--muted)] transition-colors hover:border-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]"
          >
            Page {p.pageNumber}
            {/*
              Only stated when true. `imageChanged` is null on uploads predating the perceptual
              fingerprint, and "no" there would be a claim the data cannot support.
            */}
            {p.imageChanged === true ? <span className="ml-1 text-[var(--muted-2)]">· artwork</span> : null}
          </button>
        ))}
      </div>

      {openAt !== null ? (
        <PageCompareViewer
          pages={withImages}
          index={Math.min(openAt, withImages.length - 1)}
          onIndexChange={setOpenAt}
          onClose={() => setOpenAt(null)}
          totalPages={totalPages}
          fromVersion={fromVersion}
          toVersion={toVersion}
          authorName={authorName}
          changedAt={changedAt}
        />
      ) : null}
    </div>
  );
}
