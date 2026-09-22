"use client";

/**
 * The pages that changed, previous beside new.
 *
 * Every compare has stored these two URLs per changed page since the field was added - the schema
 * comment on `DocChange.pagesThatChanged` literally says "for visual diffs in history UIs" - and
 * nothing ever rendered them. The list API mapped them away one line before returning, and the
 * history page had no field for them, so the owner's own history showed less than the recipient's
 * viewer did. Nothing here is computed: these are the same images the compare already paid to look
 * at, which is why this answers "what changed" at no per-compare cost.
 *
 * What it deliberately does not do is highlight *where* on the page. That needs a pixel diff and a
 * reflow guard, and putting two pages side by side is most of the value without either.
 */
import { useEffect, useState } from "react";

import Modal from "@/components/modals/Modal";

export type PageChange = {
  pageNumber: number;
  summary: string;
  previousImageUrl: string | null;
  newImageUrl: string | null;
  /** The perceptual verdict. Null when neither version carried a fingerprint (older uploads). */
  imageChanged: boolean | null;
};

/**
 * Images past this many changed pages load only when scrolled to.
 *
 * A compare can list up to thirty pages and each one is two full-size renders, so an expanded row
 * could otherwise pull sixty images at once on a page nobody has scrolled yet.
 */
const EAGER_PAGES = 3;

/** "v4" for a real version number, empty otherwise, so the caller can fall back to a word. */
function versionLabel(v: number | null): string {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? `v${Math.floor(v)}` : "";
}

/** One side of a pair. Keeps both sides identical when only one version has an image. */
function PageImage({
  url,
  label,
  alt,
  eager,
  onOpen,
}: {
  url: string | null;
  label: string;
  alt: string;
  eager: boolean;
  onOpen: () => void;
}) {
  return (
    <figure className="m-0 min-w-0 flex-1">
      <figcaption className="mb-1 text-[11px] font-medium text-[var(--muted)]">{label}</figcaption>
      {url ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={`${alt} (open larger)`}
          className="block w-full overflow-hidden rounded-md border border-[var(--border)] bg-[var(--panel)] transition-colors hover:border-[var(--muted-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--fg)]"
        >
          {/* Deliberately a plain img: these are Vercel Blob URLs whose host is not in the
              next/image remote allowlist, and the renders are already sized for display. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={alt}
            loading={eager ? "eager" : "lazy"}
            decoding="async"
            className="block h-auto w-full"
          />
        </button>
      ) : (
        <div className="flex aspect-[4/3] items-center justify-center rounded-md border border-dashed border-[var(--border)] bg-[var(--panel)] text-[11px] text-[var(--muted)]">
          No render stored
        </div>
      )}
    </figure>
  );
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
  const [lightbox, setLightbox] = useState<null | { url: string; alt: string }>(null);

  // Nothing to show rather than an empty frame: a compare that listed no pages, or a row old
  // enough that `attachPageContext` never populated the URLs.
  const withImages = pages.filter((p) => p.previousImageUrl || p.newImageUrl);
  useEffect(() => {
    if (!withImages.length) setLightbox(null);
  }, [withImages.length]);
  if (!withImages.length) return null;

  const fromLabel = versionLabel(fromVersion) || "previous";
  const toLabel = versionLabel(toVersion) || "new";

  /**
   * "3 of 34 changed pages", when the two differ.
   *
   * The compare caps how many pages it looks at, so a heavily edited deck lists a handful and used
   * to give no sign that the rest existed. Saying only "3 changed pages" there is wrong.
   */
  const shown = withImages.length;
  const total = typeof changedPageCount === "number" && changedPageCount > shown ? changedPageCount : null;

  return (
    <div className="mt-4">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
        {total ? `${shown} of ${total} changed pages` : `${shown} changed page${shown === 1 ? "" : "s"}`}
      </div>

      <div className="space-y-4">
        {withImages.map((p, idx) => (
          <div key={p.pageNumber} className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
            <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-xs font-semibold text-[var(--fg)]">Page {p.pageNumber}</span>
              {/*
                Only worth saying when it is true. `imageChanged` is null on uploads that predate
                the perceptual fingerprint, and "no" there would be a claim the data cannot support.
              */}
              {p.imageChanged === true ? (
                <span className="rounded-md bg-[var(--panel-hover)] px-1.5 py-0.5 text-[11px] text-[var(--muted-2)]">
                  Artwork changed
                </span>
              ) : null}
              {p.summary?.trim() ? <span className="text-xs text-[var(--muted)]">{p.summary.trim()}</span> : null}
            </div>

            <div className="flex flex-col gap-3 sm:flex-row">
              <PageImage
                url={p.previousImageUrl}
                label={fromLabel}
                alt={`Page ${p.pageNumber}, ${fromLabel}`}
                eager={idx < EAGER_PAGES}
                onOpen={() =>
                  p.previousImageUrl && setLightbox({ url: p.previousImageUrl, alt: `Page ${p.pageNumber}, ${fromLabel}` })
                }
              />
              <PageImage
                url={p.newImageUrl}
                label={toLabel}
                alt={`Page ${p.pageNumber}, ${toLabel}`}
                eager={idx < EAGER_PAGES}
                onOpen={() => p.newImageUrl && setLightbox({ url: p.newImageUrl, alt: `Page ${p.pageNumber}, ${toLabel}` })}
              />
            </div>
          </div>
        ))}
      </div>

      <Modal
        open={Boolean(lightbox)}
        onClose={() => setLightbox(null)}
        ariaLabel={lightbox?.alt ?? "Page"}
        width={1100}
        contentClassName="p-2"
      >
        {lightbox ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={lightbox.url} alt={lightbox.alt} className="block h-auto w-full rounded-md" />
            <div className="px-1 pt-2 text-[11px] text-[var(--muted)]">{lightbox.alt}</div>
          </>
        ) : null}
      </Modal>
    </div>
  );
}
