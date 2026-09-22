/**
 * Catch the page changes the perceptual fingerprint is blind to.
 *
 * `computePageFingerprint` reduces a page to a 16x16 grid of gradient comparisons and calls the
 * page changed when more than `PAGE_FINGERPRINT_MAX_DISTANCE` of those 256 bits move. That is the
 * right shape for "was this slide replaced" and the wrong shape for "was something small taken off
 * it", because a small object cannot move enough bits to clear the threshold however obvious it is
 * to a reader.
 *
 * Measured on a real deck, a logo removed from the cover - about 1% of the page area:
 *
 *     fingerprint distance      2 bits
 *     threshold to call changed 12 bits
 *     re-encode noise floor     0-7 bits
 *
 * So the change registers at 2 and the noise it must beat reaches 7. Lowering the threshold cannot
 * fix this: it would trade a missed logo for "artwork changed" on every re-upload, which is the
 * original bug the fingerprint exists to prevent. The signal is not weak, it is in the wrong space.
 * A whole-page gradient score has no way to notice something small and local.
 *
 * A region diff does, because it asks the question per cell instead of per page. The same pair
 * returns one box at 5% across and 7% down - the logo, located - and across seven real pages
 * re-encoded at JPEG quality 80, 65 and 50 it returned nothing at all. That is the property this
 * leans on: it is deaf to compression and sharp about locality, which is exactly backwards from
 * the fingerprint, so the two together cover both cases.
 *
 * Only pages nothing else already flagged are swept. A page whose text changed is in the list
 * regardless, so the cost falls on pages that look unchanged - and the answer for those is the
 * whole point.
 */
import sharp from "sharp";

import { diffRegions } from "@/lib/history/pageDiffRegions";

/** Width both renders are decoded to before comparing. Matches the viewer's own analysis width. */
const ANALYSIS_WIDTH = 640;

/** Thumbnails are small, but a 200-page document is still 400 of them. */
const MAX_PAGES = 80;

/** Enough to hide the latency of a small fetch without opening a connection per page. */
const CONCURRENCY = 8;

/** One page's two renders, by URL. */
export type SweepCandidate = { pageNumber: number; previousUrl: string; newUrl: string };

async function decode(url: string, width: number, height: number): Promise<Uint8ClampedArray | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const data = await sharp(buf)
      .resize(width, height, { fit: "contain", background: "#ffffff" })
      .ensureAlpha()
      .raw()
      .toBuffer();
    return new Uint8ClampedArray(data);
  } catch {
    return null;
  }
}

/** Decide one page by comparing its two renders. Null when either could not be read. */
async function pageDiffers(c: SweepCandidate): Promise<boolean | null> {
  // The new render's shape sets the frame, and the previous one is letterboxed into it rather than
  // stretched: a page whose box changed would otherwise move every pixel and report as changed.
  let height = Math.round((ANALYSIS_WIDTH * 9) / 16);
  try {
    const meta = await sharp(Buffer.from(await (await fetch(c.newUrl)).arrayBuffer())).metadata();
    if (meta.width && meta.height) height = Math.max(8, Math.round((ANALYSIS_WIDTH * meta.height) / meta.width));
  } catch {
    return null;
  }
  const [prev, next] = await Promise.all([decode(c.previousUrl, ANALYSIS_WIDTH, height), decode(c.newUrl, ANALYSIS_WIDTH, height)]);
  if (!prev || !next) return null;
  const result = diffRegions(prev, next, ANALYSIS_WIDTH, height);
  if (!result) return null;
  // `reflowed` means the page changed so much that regions stop being useful - still a change.
  return result.reflowed || result.boxes.length > 0;
}

/**
 * Which of these pages actually differ visually.
 *
 * Best-effort throughout: a page whose renders cannot be fetched or decoded is simply absent from
 * the result rather than guessed at, because a wrong "changed" here costs the owner a compare they
 * did not need and a wrong "unchanged" is the bug this exists to fix.
 */
export async function sweepVisualChanges(candidates: SweepCandidate[]): Promise<Set<number>> {
  const changed = new Set<number>();
  const queue = candidates.slice(0, MAX_PAGES);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= queue.length) return;
      const c = queue[i];
      const differs = await pageDiffers(c);
      if (differs === true) changed.add(c.pageNumber);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker()));
  return changed;
}
