/**
 * A close-up of the part of a page that changed.
 *
 * The model was being handed a whole 1200px page and asked which of its lines had moved. On simple
 * pages it answered correctly; on the densest column in a real deck it quoted the line *before* the
 * edit, and did so differently on each of three consecutive runs. That is not a prompt problem -
 * three runs of variance is what a question the model cannot answer looks like - and no amount of
 * further instruction fixes being asked to find a needle.
 *
 * So stop asking. The changed region is already measured by `diffRegions`, deterministically, from
 * the pixels. Cropping it out and attaching the crop turns "which line changed" into "read this",
 * which is a question a vision model is good at.
 *
 * It is also close to free on the model this runs on. A 512-square image is one tile on gpt-4o, so
 * about 255 input tokens against roughly 1,105 for a full page - a crop per page costs a quarter of
 * the page it came from.
 *
 * The crops are transient: built for the prompt, never stored. `attachPageContext` composes what it
 * persists field by field, so nothing added here reaches the database.
 */
import sharp from "sharp";

import type { DiffBox } from "@/lib/history/pageDiffRegions";

/**
 * Margin around the changed region, as a fraction of the page.
 *
 * A box drawn tightly around changed pixels clips the ascenders and descenders of the very words it
 * is pointing at, and strands them with no surrounding sentence to place them in. This is enough
 * context to read the line as a line.
 */
const PAD = 0.035;

/** Below this, a crop is too small to read; it is grown around its centre instead. */
const MIN_FRACTION = 0.12;

/** Crops wider than this are not close-ups any more, and the full page is already attached. */
const MAX_FRACTION = 0.92;

/** Ceiling on the encoded crop, to keep a stray full-page crop from dominating the request. */
const MAX_CROP_WIDTH = 1024;

/** Never more than this many close-ups for one page; the biggest regions win. */
export const MAX_CROPS_PER_PAGE = 3;

/** Pad one region and clamp it to the page. */
function windowFor(box: DiffBox): DiffBox {
  const grow = (lo: number, size: number) => {
    let a = Math.max(0, lo - PAD);
    let b = Math.min(1, lo + size + PAD);
    if (b - a < MIN_FRACTION) {
      const mid = (a + b) / 2;
      a = Math.max(0, mid - MIN_FRACTION / 2);
      b = Math.min(1, a + MIN_FRACTION);
      a = Math.max(0, b - MIN_FRACTION);
    }
    return [a, b] as const;
  };
  const [x0, x1] = grow(box.x, box.width);
  const [y0, y1] = grow(box.y, box.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Do two windows overlap enough to be worth showing as one? */
function overlaps(a: DiffBox, b: DiffBox): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * One window per region, merging only those that actually overlap once padded.
 *
 * A single window around every region is what the first version did, and on a page with an edit in
 * the top-left corner and another in the bottom-right it produced a crop covering most of the page
 * - a close-up of nothing, and a duplicate of the full render already attached. Distant edits are
 * separate close-ups.
 */
export function cropWindows(boxes: DiffBox[]): DiffBox[] {
  if (!boxes.length) return [];
  const windows = [...boxes]
    .sort((p, q) => q.width * q.height - p.width * p.height)
    .slice(0, MAX_CROPS_PER_PAGE * 2)
    .map(windowFor);

  const merged: DiffBox[] = [];
  for (const w of windows) {
    const hit = merged.find((m) => overlaps(m, w));
    if (!hit) {
      merged.push(w);
      continue;
    }
    const x0 = Math.min(hit.x, w.x);
    const y0 = Math.min(hit.y, w.y);
    const x1 = Math.max(hit.x + hit.width, w.x + w.width);
    const y1 = Math.max(hit.y + hit.height, w.y + w.height);
    hit.x = x0;
    hit.y = y0;
    hit.width = x1 - x0;
    hit.height = y1 - y0;
  }

  // A window that ended up covering the page is the page, which is already attached.
  return merged.filter((m) => !(m.width > MAX_FRACTION && m.height > MAX_FRACTION)).slice(0, MAX_CROPS_PER_PAGE);
}

/** Crop one rendered page to a window and return it as a data URL, or null on any failure. */
export async function cropToDataUrl(input: Buffer, window: DiffBox): Promise<string | null> {
  try {
    const meta = await sharp(input).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    if (W < 8 || H < 8) return null;

    const left = Math.max(0, Math.min(W - 1, Math.round(window.x * W)));
    const top = Math.max(0, Math.min(H - 1, Math.round(window.y * H)));
    const width = Math.max(8, Math.min(W - left, Math.round(window.width * W)));
    const height = Math.max(8, Math.min(H - top, Math.round(window.height * H)));

    let pipeline = sharp(input).extract({ left, top, width, height });
    if (width > MAX_CROP_WIDTH) pipeline = pipeline.resize(MAX_CROP_WIDTH);
    const out = await pipeline.jpeg({ quality: 82 }).toBuffer();
    return `data:image/jpeg;base64,${out.toString("base64")}`;
  } catch {
    return null;
  }
}

async function fetchImage(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Both versions of every changed region on one page, cropped to identical windows. */
export async function cropPairs(params: {
  previousImageUrl: string | null;
  newImageUrl: string | null;
  boxes: DiffBox[];
}): Promise<Array<{ previous: string; next: string }>> {
  const windows = cropWindows(params.boxes);
  if (!windows.length || !params.previousImageUrl || !params.newImageUrl) return [];

  // Each page is fetched once however many regions it has.
  const [prevBuf, nextBuf] = await Promise.all([fetchImage(params.previousImageUrl), fetchImage(params.newImageUrl)]);
  if (!prevBuf || !nextBuf) return [];

  const pairs = await Promise.all(
    windows.map(async (w) => {
      const [previous, next] = await Promise.all([cropToDataUrl(prevBuf, w), cropToDataUrl(nextBuf, w)]);
      return previous && next ? { previous, next } : null;
    }),
  );
  return pairs.filter((x): x is { previous: string; next: string } => Boolean(x));
}
