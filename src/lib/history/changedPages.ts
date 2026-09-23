/**
 * Page-level context for the AI compare of two document versions.
 *
 * The compare model does better when it knows which pages changed: per-page text for both versions
 * plus slide thumbnails when the page image changed. The processing job builds this for the
 * automatic compare on replacement, and the manual rerun (`POST /api/docs/:id/changes/:id/rerun`)
 * builds the same context so a paid regenerate is never thinner than the automatic run.
 */
import crypto from "node:crypto";

import type { DocChangeDiff } from "@/lib/ai/docChangeDiff";
import { isNoChangeSummary } from "@/lib/ai/docChangeSummary";
import { fingerprintsDiffer } from "@/lib/history/pageFingerprint";
import { regionsMeanChanged, sweepVisualChanges, type SweepCandidate } from "./visualPageSweep";
import type { DiffBox } from "./pageDiffRegions";
import { cropPairs } from "./pageCrops";
import { openPdfDocument } from "@/lib/pdf/renderPage";

export type PdfPageText = { page_number: number; text: string };

export type ChangedPage = {
  pageNumber: number;
  previousText: string;
  newText: string;
  previousImageUrl: string | null;
  newImageUrl: string | null;
  /**
   * Did the page's picture change? Perceptual, not byte-exact (see `pageImageChanged`).
   * null when it cannot be told: one side has no image, or neither a fingerprint nor two hashes.
   */
  imageChanged: boolean | null;
  /**
   * Where the two renders differ, as fractions of the page.
   *
   * Passed to the model so it is told which part of a page to look at rather than left to find a
   * small mark unaided - a logo removed from a dark cover came back described as a substitution
   * with the drone's tail marking, which is what an unanchored glance at a 1200px render produces.
   * Empty when the comparison could not be made.
   */
  changedRegions?: DiffBox[];
  /**
   * Each changed region of the page, cut out of both versions and encoded inline.
   *
   * Attached to the prompt beside the full pages so "which line changed" becomes "read this". One
   * entry per region rather than one per page: a single window around an edit top-left and another
   * bottom-right covers most of the page, which is a close-up of nothing. Never stored -
   * `attachPageContext` composes what it persists field by field, so these do not reach the
   * database. See `@/lib/history/pageCrops`.
   */
  changedRegionCrops?: Array<{ previous: string; next: string }>;
};

/** Max changed pages sent to the model, to keep the compare's cost bounded. */
export const MAX_PAGE_CONTEXT = 12;
/** Max pages listed in a stored diff's `pagesThatChanged`. */
const MAX_PAGES_THAT_CHANGED = 30;

/** Hash of a page's text, whitespace- and case-insensitive, so reflowed text is not "changed". */
export function pageTextHash(input: string): string {
  const normalized = (input ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

/** Extract text per page (1-indexed) from PDF bytes. */
export async function extractPdfTextByPage(pdfBytes: Uint8Array): Promise<PdfPageText[]> {
  // `openPdfDocument` copies the bytes (pdfjs detaches the buffer it is given).
  const pdf = await openPdfDocument(pdfBytes);
  try {
    const pages: PdfPageText[] = [];
    const n = Number(pdf.numPages) || 0;
    for (let i = 1; i <= n; i++) {
      const page = (await pdf.getPage(i)) as unknown;
      const getTextContent = (page as { getTextContent?: unknown } | null)?.getTextContent;
      if (typeof getTextContent !== "function") {
        pages.push({ page_number: i, text: "" });
        continue;
      }
      const content = (await (getTextContent as () => Promise<unknown>).call(page)) as { items?: unknown } | null;
      const items = Array.isArray(content?.items) ? content.items : [];
      const text = items
        .map((it: unknown) => (it && typeof it === "object" && typeof (it as { str?: unknown }).str === "string" ? (it as { str: string }).str : ""))
        .filter(Boolean)
        .join(" ");
      pages.push({ page_number: i, text });
    }
    return pages;
  } finally {
    await (pdf as { destroy?: () => Promise<unknown> }).destroy?.().catch(() => undefined);
  }
}

/** Fetch a stored PDF's bytes. */
export async function fetchPdfBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch PDF (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

type SlideInfo = {
  imageHash: string | null;
  imageFingerprint: string | null;
  thumbUrl: string | null;
  imageUrl: string | null;
};

/**
 * Did this page's picture actually change? `null` when it cannot be told.
 *
 * Prefers the perceptual fingerprint (`imageFingerprint`, see `@/lib/history/pageFingerprint`) over
 * the exact `imageHash`. The exact hash is a sha256 of the rendered page's pixels, and every MCP
 * upload now goes through Ghostscript first (`mcp/src/optimize.ts`) while the processing job
 * re-rasterizes and re-encodes every page, so a re-upload of the *same* deck produces different
 * bytes on every page every time. Byte-comparing those is what reported "graphics changed" on all
 * nine pages of an unchanged deck, under a summary saying nothing had changed.
 *
 * Uploads processed before the fingerprint existed have none, so those fall back to the exact hash:
 * old-vs-old and old-vs-new comparisons behave exactly as they did (and can still over-report), and
 * the false positive disappears once both versions have been processed with fingerprints.
 */
function pageImageChanged(prev: SlideInfo | null, next: SlideInfo | null): boolean | null {
  if (!prev || !next) return null;
  const perceptual = fingerprintsDiffer(prev.imageFingerprint, next.imageFingerprint);
  if (perceptual !== null) return perceptual;
  if (prev.imageHash && next.imageHash) return prev.imageHash !== next.imageHash;
  return null;
}

function slidesByPage(slideNodes: unknown): Map<number, SlideInfo> {
  const out = new Map<number, SlideInfo>();
  if (!Array.isArray(slideNodes)) return out;
  for (const raw of slideNodes) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    const n = Math.floor(Number(p.pageNumber ?? p.page_number));
    if (!Number.isFinite(n) || n < 1) continue;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    out.set(n, {
      imageHash: str(p.imageHash),
      imageFingerprint: str(p.imageFingerprint ?? p.image_fingerprint),
      thumbUrl: str(p.thumbUrl),
      imageUrl: str(p.imageUrl),
    });
  }
  return out;
}

function textByPage(pages: PdfPageText[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const p of pages) {
    const n = Math.floor(Number(p.page_number));
    if (Number.isFinite(n) && n >= 1) out.set(n, String(p.text ?? ""));
  }
  return out;
}

/**
 * Pages whose text or image changed between two versions, first `maxPages` of them, with both
 * versions' text and thumbnails. Pure: callers supply extracted pages and stored slide nodes.
 */
export function computeChangedPages(params: {
  prevPages: PdfPageText[];
  newPages: PdfPageText[];
  prevSlideNodes: unknown;
  nextSlideNodes: unknown;
  maxPages?: number;
  /**
   * Called with how many pages changed in total, before the `maxPages` cap is applied.
   *
   * The number is built here and then sliced away, so a 40-page deck with 34 changed pages has
   * always produced a record indistinguishable from one where 12 changed. Reported through a
   * callback rather than the return value because four call sites and three test files depend on
   * this returning a plain `ChangedPage[]`.
   */
  onTotal?: (totalChanged: number) => void;
}): ChangedPage[] {
  const prevByPage = textByPage(params.prevPages);
  const newByPage = textByPage(params.newPages);
  const prevSlides = slidesByPage(params.prevSlideNodes);
  const nextSlides = slidesByPage(params.nextSlideNodes);

  const maxPage = Math.max(0, ...prevByPage.keys(), ...newByPage.keys(), ...prevSlides.keys(), ...nextSlides.keys());
  const changed: number[] = [];
  for (let p = 1; p <= maxPage; p++) {
    const textChanged = pageTextHash(prevByPage.get(p) ?? "") !== pageTextHash(newByPage.get(p) ?? "");
    const prevImg = prevSlides.get(p) ?? null;
    const nextImg = nextSlides.get(p) ?? null;
    let imgChanged = false;
    if (prevImg || nextImg) {
      const verdict = pageImageChanged(prevImg, nextImg);
      if (verdict !== null) imgChanged = verdict;
      else {
        // Neither a fingerprint nor a pair of hashes: the URLs are all that is left to go on.
        // Reported as `imageChanged: null` below, so this only widens the context sent to the model.
        const prevUrl = prevImg?.thumbUrl ?? prevImg?.imageUrl ?? "";
        const nextUrl = nextImg?.thumbUrl ?? nextImg?.imageUrl ?? "";
        imgChanged = Boolean(prevUrl && nextUrl && prevUrl !== nextUrl);
      }
    }
    if (textChanged || imgChanged) changed.push(p);
  }

  params.onTotal?.(changed.length);

  return changed.slice(0, params.maxPages ?? MAX_PAGE_CONTEXT).map((p) => {
    const prevImg = prevSlides.get(p) ?? null;
    const nextImg = nextSlides.get(p) ?? null;
    return {
      pageNumber: p,
      previousText: prevByPage.get(p) ?? "",
      newText: newByPage.get(p) ?? "",
      /**
       * The full page render, not the thumbnail.
       *
       * These URLs are handed straight to the vision model, and they are also what the history UI
       * shows side by side. `thumbUrl` is 480px wide at JPEG quality 65 (`process/route.ts`),
       * which on a 16:9 slide leaves a logo about 24-70px across and smeared by compression:
       * enough to see that a mark is present, nowhere near enough to tell it was replaced with a
       * different one. `imageUrl` is 1200px at quality 78.
       *
       * This is not free, and an earlier version of this comment claimed it was. The argument was
       * that `detail: "high"` scales the shortest side to 768 either way, so a 480x270 thumb and a
       * 1200x675 render both cost six tiles and the thumb merely arrived upscaled. Measured against
       * the live API (`npm run measure:image-tokens`), sub-768 images are *not* scaled up: the
       * thumb is one tile at 8,500 tokens on gpt-4o-mini and the render is six at 36,835. The
       * switch was 4.3x, and twenty of them do not fit in a 128k window at all.
       *
       * What pays for it is `modelForCompare` in `@/lib/ai/docChangeDiff`, which sends anything
       * carrying images to gpt-4o, where the same render is 1,105 tokens and twenty of them are
       * 22,100. Change the rendition here and re-run that script before assuming anything.
       *
       * The thumb stays as the fallback for rows written before full-size renders existed.
       */
      previousImageUrl: prevImg?.imageUrl ?? prevImg?.thumbUrl ?? null,
      newImageUrl: nextImg?.imageUrl ?? nextImg?.thumbUrl ?? null,
      imageChanged: pageImageChanged(prevImg, nextImg),
    };
  });
}

/**
 * Compare the two renders of every page that has both, and return what differs, by page.
 *
 * One pass serving two needs. The pipeline asks "did anything change here" for pages the text and
 * fingerprint passes left unflagged, because the fingerprint is a whole-page gradient score and
 * cannot see a small local edit. The prompt asks "where", so the model is pointed at the region
 * instead of hunting for it.
 */
async function analysePageRegions(params: {
  prevSlides: Map<number, SlideInfo>;
  nextSlides: Map<number, SlideInfo>;
  pages: number[];
}) {
  const candidates: SweepCandidate[] = [];
  for (const pageNumber of params.pages) {
    const prev = params.prevSlides.get(pageNumber);
    const next = params.nextSlides.get(pageNumber);
    if (!prev || !next) continue;
    // The thumbnail is the right rendition: the comparison is coarse by design and it is a tenth
    // of the bytes of the full render across a whole deck.
    const previousUrl = prev.thumbUrl ?? prev.imageUrl;
    const newUrl = next.thumbUrl ?? next.imageUrl;
    if (!previousUrl || !newUrl) continue;
    candidates.push({ pageNumber, previousUrl, newUrl });
  }
  if (!candidates.length) return new Map();
  return await sweepVisualChanges(candidates);
}

/**
 * Build changed-page context for two stored uploads by fetching both PDFs. Best-effort: returns []
 * when either PDF is missing or cannot be read (the compare then runs on full text only).
 * `newPages` skips the second extraction when the caller already has them.
 */
export async function loadChangedPages(params: {
  prevUpload: { blobUrl?: unknown; slideNodes?: unknown } | null;
  newUpload: { blobUrl?: unknown; slideNodes?: unknown } | null;
  newPages?: PdfPageText[] | null;
  /** See `computeChangedPages`: the true changed-page count, before the cap. */
  onTotal?: (totalChanged: number) => void;
}): Promise<ChangedPage[]> {
  const prevUrl = typeof params.prevUpload?.blobUrl === "string" ? params.prevUpload.blobUrl : "";
  const newUrl = typeof params.newUpload?.blobUrl === "string" ? params.newUpload.blobUrl : "";
  if (!prevUrl || (!params.newPages && !newUrl)) return [];
  const [prevPages, newPages] = await Promise.all([
    fetchPdfBytes(prevUrl).then(extractPdfTextByPage),
    params.newPages ? Promise.resolve(params.newPages) : fetchPdfBytes(newUrl).then(extractPdfTextByPage),
  ]);
  let totalChanged: number | null = null;
  const changed = computeChangedPages({
    prevPages,
    newPages,
    prevSlideNodes: params.prevUpload?.slideNodes,
    nextSlideNodes: params.newUpload?.slideNodes,
    onTotal: (n) => {
      totalChanged = n;
    },
  });

  /**
   * Look at the pixels, for two reasons at once.
   *
   * The pages nothing flagged still need checking: the perceptual fingerprint is a whole-page
   * gradient score, so a logo removed from a real cover moved 2 of its 256 bits against a threshold
   * of 12 and a noise floor that reaches 7. Lowering the threshold would trade that miss for
   * "artwork changed" on every re-upload. A region diff asks per cell, finds the same logo exactly,
   * and stays silent across re-encodes.
   *
   * And the pages that were flagged need locating, so the model is told where to look rather than
   * left to spot a small mark on its own.
   *
   * Best-effort: a failure here leaves the text-derived answer exactly as it was.
   */
  const prevSlides = slidesByPage(params.prevUpload?.slideNodes);
  const nextSlides = slidesByPage(params.newUpload?.slideNodes);
  const flagged = new Set(changed.map((c) => c.pageNumber));
  const everyPage = [...new Set([...prevSlides.keys(), ...nextSlides.keys()])].sort((a, b) => a - b);

  const regions = await analysePageRegions({ prevSlides, nextSlides, pages: everyPage }).catch(() => new Map());
  if (!regions.size) {
    params.onTotal?.(totalChanged ?? changed.length);
    return changed;
  }

  const prevByPage = textByPage(prevPages);
  const newByPage = textByPage(newPages);
  const withRegions = changed.map((c) => {
    const r = regions.get(c.pageNumber);
    return r && !r.reflowed && r.boxes.length ? { ...c, changedRegions: r.boxes } : c;
  });

  const extra: ChangedPage[] = everyPage
    .filter((pageNumber) => !flagged.has(pageNumber) && regionsMeanChanged(regions.get(pageNumber)))
    .map((pageNumber) => {
      const prev = prevSlides.get(pageNumber) ?? null;
      const next = nextSlides.get(pageNumber) ?? null;
      const r = regions.get(pageNumber);
      return {
        pageNumber,
        previousText: prevByPage.get(pageNumber) ?? "",
        newText: newByPage.get(pageNumber) ?? "",
        previousImageUrl: prev?.imageUrl ?? prev?.thumbUrl ?? null,
        newImageUrl: next?.imageUrl ?? next?.thumbUrl ?? null,
        // A pixel comparison found it, which is a stronger statement than the fingerprint's.
        imageChanged: true,
        ...(r && !r.reflowed && r.boxes.length ? { changedRegions: r.boxes } : {}),
      } satisfies ChangedPage;
    });

  params.onTotal?.((totalChanged ?? changed.length) + extra.length);
  const all = (extra.length ? [...withRegions, ...extra].sort((a, b) => a.pageNumber - b.pageNumber) : withRegions).slice(
    0,
    MAX_PAGE_CONTEXT,
  );

  /**
   * Cut the changed region out of each page and carry it along for the prompt.
   *
   * Bounded by `MAX_CROPPED_PAGES` rather than by tier, because the caller picks how many pages to
   * attach and this only has to cover the largest of those. Best-effort per page: a crop that fails
   * leaves that page with its full images and nothing else, which is where it started.
   */
  const cropped = await Promise.all(
    all.slice(0, MAX_CROPPED_PAGES).map(async (page) => {
      if (!page.changedRegions?.length) return page;
      const crops = await cropPairs({
        previousImageUrl: page.previousImageUrl,
        newImageUrl: page.newImageUrl,
        boxes: page.changedRegions,
      }).catch(() => []);
      return crops.length ? { ...page, changedRegionCrops: crops } : page;
    }),
  ).catch(() => all.slice(0, MAX_CROPPED_PAGES));

  return [...cropped, ...all.slice(MAX_CROPPED_PAGES)];
}

/**
 * How much of a page's text is stored on the change record, per side.
 *
 * Enough for a slide or a dense page of prose, and short enough that thirty of them do not bloat a
 * document that already holds both full texts. Past the cap the word diff still renders; it simply
 * stops before the end of a very long page.
 */
const MAX_PAGE_TEXT_CHARS = 4_000;

/**
 * How many pages get a close-up of their changed region.
 *
 * Covers the largest tier's attachment budget; pages past it still carry their full renders.
 */
const MAX_CROPPED_PAGES = 10;

/** Normalize and cap one side of a page's text for storage. */
function capPageText(input: unknown): string {
  return typeof input === "string" ? input.replace(/\s+/g, " ").trim().slice(0, MAX_PAGE_TEXT_CHARS) : "";
}

/**
 * What kind of change this page carries.
 *
 * Decided from the pixels first. Every changed region is already classified by whether each side
 * has anything in it - see `RegionKind` - and that is a measurement, available on every run and the
 * same every time.
 *
 * Asking the model instead did not work. It wrote "Added 'the next 18 months'" directly above its
 * own evidence that "the coming years" used to stand there, two prompt revisions failed to shift
 * it, and the wordings it returns vary enough between runs that a kind derived from them appeared
 * and disappeared on the same page. A reader deciding whether to re-send a document needs to know
 * whether a claim was withdrawn or merely expanded, which is not a thing to leave to chance.
 *
 * The wordings remain the fallback for rows with no measured regions - old records, and pages the
 * pixel pass could not read. Null when neither can say, and the UI then says nothing.
 */
export function pageChangeKind(params: {
  regions?: Array<{ kind?: "added" | "removed" | "replaced" }> | null;
  previousWording?: unknown;
  newWording?: unknown;
}): "added" | "removed" | "replaced" | null {
  const kinds = (params.regions ?? []).map((r) => r?.kind).filter(Boolean) as Array<"added" | "removed" | "replaced">;
  if (kinds.length) {
    // One verdict for the page: unanimous regions speak for it, a mix is a replacement.
    const first = kinds[0];
    return kinds.every((k) => k === first) ? first : "replaced";
  }

  const before = typeof params.previousWording === "string" ? params.previousWording.trim() : "";
  const after = typeof params.newWording === "string" ? params.newWording.trim() : "";
  if (!before && !after) return null;
  if (!before) return "added";
  if (!after) return "removed";
  return before.toLowerCase() === after.toLowerCase() ? null : "replaced";
}

/**
 * Attach thumbnails and image-change hints to a diff's `pagesThatChanged`, and add pages whose
 * graphics changed but that the model did not list. Returns the diff unchanged when it has none.
 */
export function attachPageContext<T extends DocChangeDiff | null>(diff: T, changedPages: ChangedPage[]): T {
  if (!diff || typeof diff !== "object") return diff;
  // A "no changes" diff can never carry changed pages - the modal printed both at once and the page
  // list was the one that lied. Enforced here as well as at the source, since this is the last stop
  // before the diff is stored (see `@/lib/ai/docChangeSummary`).
  if (isNoChangeSummary((diff as { summary?: unknown }).summary)) {
    return { ...diff, pagesThatChanged: [] } as T;
  }
  const ctxByPage = new Map(changedPages.map((p) => [p.pageNumber, p]));
  const base = Array.isArray((diff as { pagesThatChanged?: unknown }).pagesThatChanged)
    ? ((diff as { pagesThatChanged: Array<Record<string, unknown>> }).pagesThatChanged)
    : [];
  const seen = new Set<number>();
  const augmented = base.map((p) => {
    const n = typeof p?.pageNumber === "number" ? Math.floor(p.pageNumber) : NaN;
    if (!Number.isFinite(n) || n < 1) return p;
    seen.add(n);
    const ctx = ctxByPage.get(n) ?? null;
    return {
      ...p,
      previousImageUrl: ctx?.previousImageUrl ?? null,
      newImageUrl: ctx?.newImageUrl ?? null,
      imageChanged: ctx?.imageChanged ?? null,
      previousText: capPageText(ctx?.previousText),
      newText: capPageText(ctx?.newText),
      changeKind: pageChangeKind({
        regions: ctx?.changedRegions,
        previousWording: (p as Record<string, unknown>)?.previousWording,
        newWording: (p as Record<string, unknown>)?.newWording,
      }),
    };
  });
  const imageOnly = changedPages
    .filter((p) => !seen.has(p.pageNumber) && p.imageChanged === true)
    .slice(0, Math.max(0, MAX_PAGES_THAT_CHANGED - augmented.length))
    .map((p) => ({
      pageNumber: p.pageNumber,
      summary: "Graphics/visuals changed on this page.",
      previousImageUrl: p.previousImageUrl,
      newImageUrl: p.newImageUrl,
      imageChanged: true,
      previousText: capPageText(p.previousText),
      newText: capPageText(p.newText),
      // No wordings here, but the regions were measured, so the pixels still answer.
      changeKind: pageChangeKind({ regions: p.changedRegions }),
    }));
  return { ...diff, pagesThatChanged: [...augmented, ...imageOnly].slice(0, MAX_PAGES_THAT_CHANGED) } as T;
}
