/**
 * Donut geometry: values in, SVG annulus-sector paths out.
 *
 * Pure maths with no React and no SVG rendering, so the arcs can be tested directly. Angles run
 * clockwise from twelve o'clock, which is the order a reader expects a share to be drawn in.
 */

export type DonutInput = { key: string; value: number };

export type DonutArc = {
  key: string;
  value: number;
  /** Fraction of the total, 0–1. */
  share: number;
  /** Radians, clockwise from twelve o'clock. */
  startAngle: number;
  endAngle: number;
  /** Midpoint angle, for a label or a leader line. */
  midAngle: number;
  /** `d` for the annulus sector (a closed ring when the slice is the whole total). */
  path: string;
};

export type DonutOptions = {
  /** Width and height of the square viewBox. */
  size: number;
  /** Ring thickness in the same units; clamped to the radius. */
  thickness: number;
  /** Visual gap between neighbouring slices, in the same units, measured at the ring's midline. */
  gap?: number;
};

const TAU = Math.PI * 2;

/** Round to 3 decimals so paths stay short and comparisons in tests are stable. */
function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Point on a circle of radius `radius` at `angle` radians clockwise from twelve o'clock. */
export function polarPoint(cx: number, cy: number, radius: number, angle: number): { x: number; y: number } {
  return { x: r3(cx + radius * Math.sin(angle)), y: r3(cy - radius * Math.cos(angle)) };
}

/** Path for a complete ring — an arc cannot close on itself, so it is drawn as two half circles. */
function ringPath(cx: number, cy: number, outer: number, inner: number): string {
  const oTop = polarPoint(cx, cy, outer, 0);
  const oBottom = polarPoint(cx, cy, outer, Math.PI);
  const iTop = polarPoint(cx, cy, inner, 0);
  const iBottom = polarPoint(cx, cy, inner, Math.PI);
  return [
    `M ${oTop.x} ${oTop.y}`,
    `A ${outer} ${outer} 0 0 1 ${oBottom.x} ${oBottom.y}`,
    `A ${outer} ${outer} 0 0 1 ${oTop.x} ${oTop.y}`,
    `M ${iTop.x} ${iTop.y}`,
    `A ${inner} ${inner} 0 0 0 ${iBottom.x} ${iBottom.y}`,
    `A ${inner} ${inner} 0 0 0 ${iTop.x} ${iTop.y}`,
    "Z",
  ].join(" ");
}

/** Path for one annulus sector between two angles. */
function sectorPath(cx: number, cy: number, outer: number, inner: number, start: number, end: number): string {
  const largeArc = end - start > Math.PI ? 1 : 0;
  const o0 = polarPoint(cx, cy, outer, start);
  const o1 = polarPoint(cx, cy, outer, end);
  const i1 = polarPoint(cx, cy, inner, end);
  const i0 = polarPoint(cx, cy, inner, start);
  return [
    `M ${o0.x} ${o0.y}`,
    `A ${outer} ${outer} 0 ${largeArc} 1 ${o1.x} ${o1.y}`,
    `L ${i1.x} ${i1.y}`,
    `A ${inner} ${inner} 0 ${largeArc} 0 ${i0.x} ${i0.y}`,
    "Z",
  ].join(" ");
}

/**
 * Arcs for a donut.
 *
 * Zero or negative totals return `[]` (there is no circle to draw, and the caller shows its own
 * empty state rather than a ring of nothing). A single slice holding the whole total is drawn as a
 * closed ring with no gap, because a gap needs two neighbours to sit between. Slices are laid out
 * in the order given: colour follows the entity, so the caller decides the order, not the maths.
 */
export function donutArcs(slices: readonly DonutInput[], options: DonutOptions): DonutArc[] {
  const { size, thickness } = options;
  const cx = size / 2;
  const cy = size / 2;
  const outer = Math.max(0, size / 2);
  const inner = Math.max(0, outer - Math.max(0, thickness));
  const positive = slices.filter((s) => Number.isFinite(s.value) && s.value > 0);
  const total = positive.reduce((sum, s) => sum + s.value, 0);
  if (!positive.length || total <= 0 || outer <= 0) return [];

  if (positive.length === 1) {
    const only = positive[0]!;
    return [
      {
        key: only.key,
        value: only.value,
        share: 1,
        startAngle: 0,
        endAngle: TAU,
        midAngle: Math.PI,
        path: ringPath(cx, cy, outer, inner),
      },
    ];
  }

  // The gap is given in pixels at the ring's midline; convert it once into an angle and take half
  // off each end of every slice, so neighbours are separated by the full gap.
  const midRadius = (outer + inner) / 2 || outer;
  const gapPx = Math.max(0, options.gap ?? 0);
  // Never let the gaps eat more than a third of the circle, however many slices there are.
  const gapAngle = midRadius > 0 ? Math.min(gapPx / midRadius, TAU / (positive.length * 3)) : 0;

  const arcs: DonutArc[] = [];
  let cursor = 0;
  for (const s of positive) {
    const share = s.value / total;
    const span = share * TAU;
    const start = cursor + gapAngle / 2;
    // A slice narrower than its own gap collapses to a hairline rather than inverting.
    const end = Math.max(start, cursor + span - gapAngle / 2);
    arcs.push({
      key: s.key,
      value: s.value,
      share,
      startAngle: start,
      endAngle: end,
      midAngle: (start + end) / 2,
      path: sectorPath(cx, cy, outer, inner, start, end),
    });
    cursor += span;
  }
  return arcs;
}

/** "42%" for a share, rounded, with no slice that has any value ever shown as 0%. */
export function formatShare(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return "0%";
  const pct = share * 100;
  return `${pct < 1 ? "<1" : Math.round(pct)}%`;
}
