/**
 * Value labels for recharts series: pass the result of `valueLabels(...)` as a `<LabelList
 * content>`. One renderer for every metrics chart so they label the same way:
 *
 * - zero days are never labelled;
 * - a short series (≤ 14 points) labels every other day; a longer one labels only its peaks, so a
 *   30- or 90-day chart shows its high points instead of a wall of numbers;
 * - `mode: "max"` labels just the series' highest day (for charts with several lines, where even
 *   peaks from four series collide);
 * - a label closer than `minGapPx` to the previous one is dropped;
 * - the first and last points anchor inward, so the card edge never clips a number.
 */
import type { ReactElement } from "react";

type Box = { x?: number | string; y?: number | string; width?: number | string; height?: number | string };
type LabelProps = Box & { viewBox?: Box; value?: unknown; index?: number };

const DENSE_AFTER = 14;

export function valueLabels(opts: {
  values: number[];
  format?: (n: number) => string;
  mode?: "auto" | "max";
  minGapPx?: number;
  fill?: string;
}): (props: object) => ReactElement | null {
  const values = opts.values.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : 0));
  const format = opts.format ?? ((n: number) => n.toLocaleString());
  const minGap = opts.minGapPx ?? 22;
  const dense = values.length > DENSE_AFTER;
  const maxIdx = values.reduce((best, v, i) => (v > values[best] ? i : best), 0);
  // Decided once per point and remembered: recharts renders each label more than once per pass,
  // and a gap check against "the last label drawn" then compared a point with itself and dropped it.
  const accepted = new Map<number, number>();

  return function ValueLabel(raw: object) {
    const props = raw as LabelProps;
    const i = props.index ?? -1;
    const v = values[i] ?? 0;
    if (!(v > 0)) return null;
    if (opts.mode === "max") {
      if (i !== maxIdx) return null;
    } else if (dense) {
      const prev = values[i - 1] ?? -1;
      const next = values[i + 1] ?? -1;
      if (!(v > prev && v >= next)) return null;
    }
    // recharts 3 hands the position over as `viewBox`: a bar's rectangle (left edge + width), or a
    // zero-width box at a line/area point. Centre on it either way.
    const box = props.viewBox ?? props;
    const x = Number(box.x) + (Number(box.width) || 0) / 2;
    const y = Number(box.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (!accepted.has(i)) {
      let prevX = Number.NEGATIVE_INFINITY;
      for (const [j, jx] of accepted) if (j < i && jx > prevX) prevX = jx;
      if (x - prevX < minGap) return null;
      accepted.set(i, x);
    }
    const anchor = i === 0 ? "start" : i === values.length - 1 ? "end" : "middle";
    return (
      <text x={x} y={y - 6} textAnchor={anchor} fontSize={10} fontWeight={600} fill={opts.fill ?? "var(--muted)"}>
        {format(v)}
      </text>
    );
  };
}
