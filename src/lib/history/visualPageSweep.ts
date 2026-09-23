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
 * Every page with a render on both sides is compared, not only the unflagged ones. Pages the text
 * pass already flagged still need their regions located, because the crop handed to the model and
 * the marks drawn in the viewer both come from here. The unflagged ones are what this was built
 * for; the flagged ones get their geometry along the way.
 */
import sharp from "sharp";

import { diffRegions, type DiffRegions } from "@/lib/history/pageDiffRegions";
import { debugLog } from "@/lib/debug";

/** Width both renders are decoded to before comparing. Matches the viewer's own analysis width. */
const ANALYSIS_WIDTH = 640;

/** Thumbnails are small, but a 200-page document is still 400 of them. */
const MAX_PAGES = 80;

/** Enough to hide the latency of a small fetch without opening a connection per page. */
const CONCURRENCY = 8;

/** One page's two renders, by URL. */
export type SweepCandidate = { pageNumber: number; previousUrl: string; newUrl: string };

/** Fetch once; every caller below works from the bytes rather than the URL. */
async function fetchBytes(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

async function decode(buf: Buffer, width: number, height: number): Promise<Uint8ClampedArray | null> {
  try {
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

/** Compare one page's two renders. Null when either could not be read. */
async function pageRegions(c: SweepCandidate): Promise<DiffRegions | null> {
  // Two fetches, not three. The new render used to be pulled once for its dimensions and then a
  // second time to decode, so a 50-page replacement made 150 blob round trips where 100 would do,
  // on the critical path of every replacement.
  const [prevBuf, nextBuf] = await Promise.all([fetchBytes(c.previousUrl), fetchBytes(c.newUrl)]);
  if (!prevBuf || !nextBuf) return null;

  // The new render's shape sets the frame, and the previous one is letterboxed into it rather than
  // stretched: a page whose box changed would otherwise move every pixel and report as changed.
  let height = Math.round((ANALYSIS_WIDTH * 9) / 16);
  try {
    const meta = await sharp(nextBuf).metadata();
    if (meta.width && meta.height) height = Math.max(8, Math.round((ANALYSIS_WIDTH * meta.height) / meta.width));
  } catch {
    return null;
  }

  const [prev, next] = await Promise.all([decode(prevBuf, ANALYSIS_WIDTH, height), decode(nextBuf, ANALYSIS_WIDTH, height)]);
  if (!prev || !next) return null;
  return diffRegions(prev, next, ANALYSIS_WIDTH, height);
}

/** Did this page change at all? `reflowed` means it changed too much to box, which is still a change. */
export function regionsMeanChanged(r: DiffRegions | null | undefined): boolean {
  return Boolean(r && (r.reflowed || r.boxes.length > 0));
}

/**
 * Where each of these pages differs, by page number.
 *
 * Serves two callers at once, which is why it returns the regions rather than a verdict. The
 * pipeline uses "are there any" to catch pages the fingerprint missed; the prompt uses the
 * rectangles themselves, so the model is told where to look on a page instead of being left to
 * find a small mark unaided - which is how a removed logo came back described as a substitution.
 *
 * Best-effort throughout: a page whose renders cannot be fetched or decoded is simply absent
 * rather than guessed at, because a wrong "changed" costs a compare nobody needed and a wrong
 * "unchanged" is the bug this exists to fix.
 */
export async function sweepVisualChanges(candidates: SweepCandidate[]): Promise<Map<number, DiffRegions>> {
  const out = new Map<number, DiffRegions>();
  const queue = candidates.slice(0, MAX_PAGES);
  // Say when the cap bites. Past it a small local edit is simply never looked for, and silence
  // there is indistinguishable from "nothing changed on those pages".
  if (candidates.length > MAX_PAGES) {
    debugLog(1, "[visualPageSweep] page cap reached; later pages not swept", {
      candidates: candidates.length,
      swept: MAX_PAGES,
    });
  }
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= queue.length) return;
      const c = queue[i];
      const regions = await pageRegions(c);
      if (regions) out.set(c.pageNumber, regions);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker()));
  return out;
}
