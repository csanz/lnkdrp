/**
 * The changed-region maths, and the two properties that decide whether it is worth showing.
 *
 * A highlight people learn to distrust is worse than no highlight, so the first property is that
 * an unchanged page produces nothing at all. Every upload is re-rasterized and re-compressed, so
 * the same page never yields identical pixels; a threshold tuned even slightly too low turns every
 * re-upload into a page covered in marks. Measured against real renders from the app, the same
 * page re-encoded at JPEG quality 80, 65 and 50 gave 0.0000% coverage across seven pages.
 *
 * The second is that one edit comes back as one region. Before the merge radius existed, a single
 * rewritten paragraph produced nine overlapping boxes - every run of altered words its own
 * component, because the unchanged words between them broke the connection. That marks the page
 * without pointing at anything.
 */
import { describe, expect, test } from "vitest";

import { CELL_PX, MAX_BOXES, REFLOW_COVERAGE, diffRegions } from "@/lib/history/pageDiffRegions";

const W = 320;
const H = 240;

/** A white page as RGBA. */
function page(): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(W * H * 4);
  buf.fill(255);
  return buf;
}

/** Paint a rectangle, in pixels, at a given grey level. */
function paint(buf: Uint8ClampedArray, x: number, y: number, w: number, h: number, value: number): void {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = (yy * W + xx) * 4;
      buf[i] = value;
      buf[i + 1] = value;
      buf[i + 2] = value;
      buf[i + 3] = 255;
    }
  }
}

/** Every pixel nudged, as a re-encode would: below the threshold everywhere. */
function withNoise(buf: Uint8ClampedArray, amplitude: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(buf);
  for (let i = 0; i < out.length; i += 4) {
    const d = ((i / 4) % 7) - 3; // deterministic, both signs, no Math.random in tests
    const v = Math.max(0, Math.min(255, out[i] + d * amplitude));
    out[i] = v;
    out[i + 1] = v;
    out[i + 2] = v;
  }
  return out;
}

describe("an unchanged page produces no marks", () => {
  test("identical pages give nothing", () => {
    const r = diffRegions(page(), page(), W, H);
    expect(r).toEqual({ boxes: [], coverage: 0, reflowed: false });
  });

  test("compression-scale noise everywhere is not a change", () => {
    // This is the property the whole feature rests on. A page nobody edited must come back clean.
    const a = page();
    const r = diffRegions(a, withNoise(a, 2), W, H);
    expect(r?.boxes).toEqual([]);
    expect(r?.coverage).toBe(0);
  });
});

describe("a real change is found, and located", () => {
  test("one painted block gives one box around it", () => {
    const a = page();
    const b = page();
    paint(b, 80, 60, 64, 32, 0);
    const r = diffRegions(a, b, W, H);
    expect(r?.boxes).toHaveLength(1);
    const box = r!.boxes[0];
    // Within one cell of the truth on every edge: the grid quantises to CELL_PX.
    const tol = CELL_PX / W + 0.001;
    expect(box.x).toBeGreaterThanOrEqual(80 / W - tol);
    expect(box.x).toBeLessThanOrEqual(80 / W + tol);
    expect(box.width).toBeGreaterThanOrEqual(64 / W - 2 * tol);
    expect(box.y).toBeGreaterThanOrEqual(60 / H - CELL_PX / H - 0.001);
  });

  test("two edits far apart stay two regions", () => {
    const a = page();
    const b = page();
    paint(b, 16, 16, 40, 24, 0);
    paint(b, 240, 190, 40, 24, 0);
    const r = diffRegions(a, b, W, H);
    expect(r?.boxes).toHaveLength(2);
  });

  test("fragments of one edit merge into a single region", () => {
    // Words changed, words between them unchanged: the shape of a rewritten line. Without the
    // merge radius this returned one box per fragment.
    const a = page();
    const b = page();
    for (const x of [40, 72, 104, 136]) paint(b, x, 100, 16, 16, 0);
    const r = diffRegions(a, b, W, H);
    expect(r?.boxes).toHaveLength(1);
    expect(r!.boxes[0].width).toBeGreaterThan(100 / W);
  });

  test("boxes come back in reading order", () => {
    const a = page();
    const b = page();
    paint(b, 200, 180, 32, 24, 0);
    paint(b, 24, 24, 32, 24, 0);
    const r = diffRegions(a, b, W, H);
    expect(r!.boxes.map((x) => Math.round(x.y * 100))).toEqual([...r!.boxes.map((x) => Math.round(x.y * 100))].sort((p, q) => p - q));
  });
});

describe("a reflowed page reports rather than marks", () => {
  test("a page that changed almost everywhere draws nothing", () => {
    // Insert a line at the top and everything below shifts. Every cell it passes through differs,
    // truthfully and uselessly - a page covered in boxes reads as a broken feature.
    const a = page();
    const b = page();
    paint(b, 0, 0, W, H, 0);
    const r = diffRegions(a, b, W, H);
    expect(r?.reflowed).toBe(true);
    expect(r?.boxes).toEqual([]);
    expect(r!.coverage).toBeGreaterThan(REFLOW_COVERAGE);
  });
});

describe("guards", () => {
  test("never more boxes than the cap", () => {
    const a = page();
    const b = page();
    // Widely separated specks, more than the cap allows.
    for (let i = 0; i < MAX_BOXES + 6; i++) {
      const x = 8 + (i % 6) * 50;
      const y = 8 + Math.floor(i / 6) * 70;
      if (x + 16 < W && y + 16 < H) paint(b, x, y, 16, 16, 0);
    }
    const r = diffRegions(a, b, W, H);
    expect(r!.boxes.length).toBeLessThanOrEqual(MAX_BOXES + 1);
  });

  test("mismatched or unusable buffers return null rather than guessing", () => {
    expect(diffRegions(page(), new Uint8ClampedArray(4), W, H)).toBeNull();
    expect(diffRegions(page(), page(), 2, 2)).toBeNull();
  });

  test("every box stays inside the page", () => {
    const a = page();
    const b = page();
    paint(b, W - 24, H - 24, 24, 24, 0);
    const r = diffRegions(a, b, W, H);
    for (const box of r!.boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(1.0001);
      expect(box.y + box.height).toBeLessThanOrEqual(1.0001);
    }
  });
});
