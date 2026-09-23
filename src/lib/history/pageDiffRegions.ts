/**
 * Where two renders of the same page differ, as boxes.
 *
 * This runs in the viewer's browser, on the two images it has already downloaded, which is what
 * makes it worth doing at all. The same calculation on the server would mean fetching both JPEGs
 * per changed page, decoding them, storing the result, and a schema migration - for something the
 * client can do in a few milliseconds on pixels already in memory. Nothing here touches a model, a
 * blob or the database.
 *
 * The method is deliberately coarse. Both versions are re-rasterized and re-compressed on every
 * upload, so the same page never produces identical pixels; comparing per-pixel would light up the
 * whole page on a file that did not change at all. Instead the page is divided into cells, each
 * cell reduced to its mean brightness, and a cell counted as changed only when those means move
 * further apart than compression noise can explain. That is a blur and a threshold, in the cheapest
 * form available.
 *
 * What it cannot do is tell a change from a shift. Insert one line near the top of a page and
 * everything below it moves down; every cell it passes through differs, truthfully and uselessly.
 * `coverage` exists for exactly that case - see `REFLOW_COVERAGE`, and the caller is expected to
 * say "this page was reworked" rather than draw a box around the whole thing.
 */

/**
 * What happened inside one region, decided from whether each side has anything in it.
 *
 * "added" is content where the page was bare, "removed" is a bare patch where content was, and
 * "replaced" is content on both sides that differs. Derived from the pixels, so it does not depend
 * on the model returning anything, which is the point: the same fact asked of the model came back
 * as "added" for a replacement, and came back differently on repeat runs.
 */
export type RegionKind = "added" | "removed" | "replaced";

/** A region that differs, in fractions of the page (0-1), so it overlays any rendition. */
export type DiffBox = { x: number; y: number; width: number; height: number; kind?: RegionKind };

export type DiffRegions = {
  boxes: DiffBox[];
  /** Fraction of the page's cells that changed, 0-1. */
  coverage: number;
  /** True when coverage is high enough that boxes would mislead rather than inform. */
  reflowed: boolean;
};

/**
 * Cell size in analysis pixels.
 *
 * Small enough to bound a changed line of text, large enough that its mean is a real average
 * rather than a few glyph edges. At the 640px analysis width below, 8px is about 1.25% of the page
 * across.
 */
export const CELL_PX = 8;

/**
 * How far two cell means must move before the cell counts as changed, on a 0-255 scale.
 *
 * Averaging 64 pixels is itself a strong blur, so JPEG artefacts and anti-aliasing on identical
 * content land near zero - a real page re-encoded at quality 55 measured 0.00 coverage here. 9 sits
 * well clear of that while still catching a single digit changing inside a heading, which was the
 * case a higher threshold quietly dropped: "rev 2" to "rev 3" moves one cell by about 12.
 */
export const CELL_THRESHOLD = 9;

/** Components with fewer genuinely-changed cells than this are noise, not a change. */
export const MIN_CELLS = 2;

/**
 * How far a changed cell reaches when deciding what belongs to the same region, in cells.
 *
 * Without this, one edited paragraph comes back as nine separate boxes - every run of altered
 * words its own component, because the unchanged words between them break the connection. Nine
 * overlapping rectangles on one paragraph is confetti: it marks the page without pointing at
 * anything. Growing the mask by two cells before grouping closes those gaps, so the paragraph is
 * one region and a separate edit elsewhere on the page stays separate.
 *
 * The growth is used only for grouping. Each box is still drawn around the cells that actually
 * changed, so the mark stays tight even though the grouping is generous.
 */
export const MERGE_RADIUS = 2;

/**
 * Above this fraction of changed cells, the page reflowed or was redesigned and boxes stop meaning
 * anything. Measured against the alternative: a page covered in boxes reads as a broken feature.
 */
export const REFLOW_COVERAGE = 0.35;

/** Never draw more than this; the rest are merged into one box covering them all. */
export const MAX_BOXES = 8;

/**
 * How far a region's mean brightness may sit from the page's own background and still count as
 * bare, on a 0-255 scale.
 *
 * The page's background is taken as the median cell brightness, which on a document page is
 * whatever the paper is - white on a light slide, near-black on a dark one - so this works on both
 * without being told which it is. A region holding a line of text or a logo moves well clear of it;
 * a region holding nothing sits on it.
 */
export const BARE_DELTA = 6;

/** Rec. 601 luma. Alpha is ignored: page renders are opaque JPEGs. */
function luma(data: Uint8ClampedArray, i: number): number {
  return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
}

/** Mean brightness of every cell, row-major. */
function cellMeans(data: Uint8ClampedArray, width: number, height: number, cols: number, rows: number): Float32Array {
  const means = new Float32Array(cols * rows);
  const counts = new Uint32Array(cols * rows);
  for (let y = 0; y < height; y++) {
    const cy = Math.min(rows - 1, (y / CELL_PX) | 0);
    for (let x = 0; x < width; x++) {
      const cx = Math.min(cols - 1, (x / CELL_PX) | 0);
      const c = cy * cols + cx;
      means[c] += luma(data, (y * width + x) * 4);
      counts[c] += 1;
    }
  }
  for (let i = 0; i < means.length; i++) if (counts[i]) means[i] /= counts[i];
  return means;
}

/**
 * Compare two same-sized RGBA buffers and return the regions that differ.
 *
 * Both buffers must already be the same dimensions; the caller scales them onto a common canvas,
 * which is also where a page whose aspect ratio changed gets letterboxed rather than stretched.
 * Returns null when the inputs are unusable rather than guessing.
 */
export function diffRegions(
  previous: Uint8ClampedArray,
  next: Uint8ClampedArray,
  width: number,
  height: number,
): DiffRegions | null {
  if (width < CELL_PX || height < CELL_PX) return null;
  if (previous.length !== next.length || previous.length < width * height * 4) return null;

  const cols = Math.ceil(width / CELL_PX);
  const rows = Math.ceil(height / CELL_PX);
  const a = cellMeans(previous, width, height, cols, rows);
  const b = cellMeans(next, width, height, cols, rows);

  const changed = new Uint8Array(cols * rows);
  let changedCount = 0;
  for (let i = 0; i < changed.length; i++) {
    if (Math.abs(a[i] - b[i]) > CELL_THRESHOLD) {
      changed[i] = 1;
      changedCount += 1;
    }
  }

  /**
   * The page's own background, per side, as the median cell brightness.
   *
   * Median rather than mean: a mean is dragged around by a large image or a dark band, while the
   * median is whatever most of the page is, which is what "bare" has to be measured against.
   */
  const median = (values: Float32Array) => {
    const sorted = Float32Array.from(values).sort();
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  };
  const bgA = median(a);
  const bgB = median(b);

  const coverage = changed.length ? changedCount / changed.length : 0;
  if (!changedCount) return { boxes: [], coverage: 0, reflowed: false };
  if (coverage > REFLOW_COVERAGE) return { boxes: [], coverage, reflowed: true };

  /**
   * Grow the mask before grouping: see `MERGE_RADIUS`. Chebyshev distance, so the growth is square
   * and a diagonal gap between two edits closes as readily as a horizontal one.
   */
  const grown = new Uint8Array(changed.length);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      if (!changed[cy * cols + cx]) continue;
      const yLo = Math.max(0, cy - MERGE_RADIUS);
      const yHi = Math.min(rows - 1, cy + MERGE_RADIUS);
      const xLo = Math.max(0, cx - MERGE_RADIUS);
      const xHi = Math.min(cols - 1, cx + MERGE_RADIUS);
      for (let y = yLo; y <= yHi; y++) for (let x = xLo; x <= xHi; x++) grown[y * cols + x] = 1;
    }
  }

  // Flood fill over the grown mask, 4-connected, iterative so a page-sized component cannot blow
  // the stack. Bounds and the noise test come from the cells that really changed, not the growth.
  const seen = new Uint8Array(changed.length);
  const found: Array<{ x0: number; y0: number; x1: number; y1: number; cells: number }> = [];
  const stack: number[] = [];
  for (let start = 0; start < grown.length; start++) {
    if (!grown[start] || seen[start]) continue;
    stack.push(start);
    seen[start] = 1;
    let x0 = cols;
    let y0 = rows;
    let x1 = -1;
    let y1 = -1;
    let cells = 0;
    while (stack.length) {
      const idx = stack.pop() as number;
      const cx = idx % cols;
      const cy = (idx / cols) | 0;
      if (changed[idx]) {
        cells += 1;
        if (cx < x0) x0 = cx;
        if (cy < y0) y0 = cy;
        if (cx > x1) x1 = cx;
        if (cy > y1) y1 = cy;
      }
      const neighbours = [cx > 0 ? idx - 1 : -1, cx < cols - 1 ? idx + 1 : -1, cy > 0 ? idx - cols : -1, cy < rows - 1 ? idx + cols : -1];
      for (const n of neighbours) {
        if (n >= 0 && grown[n] && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    if (cells >= MIN_CELLS && x1 >= x0 && y1 >= y0) found.push({ x0, y0, x1, y1, cells });
  }

  if (!found.length) return { boxes: [], coverage, reflowed: false };

  // Biggest first, so the cap keeps what matters and merges the tail.
  found.sort((p, q) => q.cells - p.cells);
  const kept = found.slice(0, MAX_BOXES);
  const rest = found.slice(MAX_BOXES);
  if (rest.length) {
    const union = rest.reduce(
      (acc, r) => ({
        x0: Math.min(acc.x0, r.x0),
        y0: Math.min(acc.y0, r.y0),
        x1: Math.max(acc.x1, r.x1),
        y1: Math.max(acc.y1, r.y1),
        cells: acc.cells + r.cells,
      }),
      rest[0],
    );
    kept.push(union);
  }

  /** Mean brightness of one side inside a cell rectangle. */
  const meanIn = (means: Float32Array, r: { x0: number; y0: number; x1: number; y1: number }) => {
    let total = 0;
    let n = 0;
    for (let cy = r.y0; cy <= r.y1; cy++) {
      for (let cx = r.x0; cx <= r.x1; cx++) {
        total += means[cy * cols + cx];
        n += 1;
      }
    }
    return n ? total / n : 0;
  };

  // Back to page fractions. `+1` because a box spans through the end of its last cell.
  const boxes = kept
    .map((r) => {
      const bareBefore = Math.abs(meanIn(a, r) - bgA) < BARE_DELTA;
      const bareAfter = Math.abs(meanIn(b, r) - bgB) < BARE_DELTA;
      const kind: RegionKind = bareBefore && !bareAfter ? "added" : !bareBefore && bareAfter ? "removed" : "replaced";
      return {
        x: (r.x0 * CELL_PX) / width,
        y: (r.y0 * CELL_PX) / height,
        width: Math.min(1, ((r.x1 + 1) * CELL_PX) / width) - (r.x0 * CELL_PX) / width,
        height: Math.min(1, ((r.y1 + 1) * CELL_PX) / height) - (r.y0 * CELL_PX) / height,
        kind,
      };
    })
    .sort((p, q) => p.y - q.y || p.x - q.x);

  return { boxes, coverage, reflowed: false };
}
