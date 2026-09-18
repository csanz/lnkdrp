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

  return changed.slice(0, params.maxPages ?? MAX_PAGE_CONTEXT).map((p) => {
    const prevImg = prevSlides.get(p) ?? null;
    const nextImg = nextSlides.get(p) ?? null;
    return {
      pageNumber: p,
      previousText: prevByPage.get(p) ?? "",
      newText: newByPage.get(p) ?? "",
      previousImageUrl: prevImg?.thumbUrl ?? prevImg?.imageUrl ?? null,
      newImageUrl: nextImg?.thumbUrl ?? nextImg?.imageUrl ?? null,
      imageChanged: pageImageChanged(prevImg, nextImg),
    };
  });
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
}): Promise<ChangedPage[]> {
  const prevUrl = typeof params.prevUpload?.blobUrl === "string" ? params.prevUpload.blobUrl : "";
  const newUrl = typeof params.newUpload?.blobUrl === "string" ? params.newUpload.blobUrl : "";
  if (!prevUrl || (!params.newPages && !newUrl)) return [];
  const [prevPages, newPages] = await Promise.all([
    fetchPdfBytes(prevUrl).then(extractPdfTextByPage),
    params.newPages ? Promise.resolve(params.newPages) : fetchPdfBytes(newUrl).then(extractPdfTextByPage),
  ]);
  return computeChangedPages({
    prevPages,
    newPages,
    prevSlideNodes: params.prevUpload?.slideNodes,
    nextSlideNodes: params.newUpload?.slideNodes,
  });
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
    return { ...p, previousImageUrl: ctx?.previousImageUrl ?? null, newImageUrl: ctx?.newImageUrl ?? null, imageChanged: ctx?.imageChanged ?? null };
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
    }));
  return { ...diff, pagesThatChanged: [...augmented, ...imageOnly].slice(0, MAX_PAGES_THAT_CHANGED) } as T;
}
