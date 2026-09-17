/** Layout math for the side panel's people-by-day bars, kept pure so it can be tested without a DOM. */

export type ChartTick = { index: number; anchor: "start" | "middle" | "end" };

/** Rough rendered width of a 10px label; generous so near-misses count as collisions. */
const CHAR_PX = 6;

/**
 * X-axis ticks: the first and last day, plus the midpoint — or, when activity sits in a narrow
 * stretch (under a third of the range), the first and last active day instead, so a cluster of bars
 * has a date beside it that matches "Last opened". Ticks that would overlap an earlier-chosen tick
 * or spill past the chart are dropped; the order of `candidates` is the priority.
 */
export function chartTicks(values: number[], labels: string[], widthPx: number, marginPx = 2): ChartTick[] {
  const n = values.length;
  if (!n) return [];
  const slot = Math.max(0, widthPx - 2 * marginPx) / n;
  const nonZero = values.flatMap((v, i) => (v > 0 ? [i] : []));
  const firstActive = nonZero[0];
  const lastActive = nonZero[nonZero.length - 1];
  const narrow = firstActive !== undefined && lastActive !== undefined && lastActive - firstActive + 1 < n / 3;
  const candidates = narrow ? [0, n - 1, lastActive, firstActive] : [0, n - 1, Math.floor((n - 1) / 2)];

  const accepted: Array<ChartTick & { from: number; to: number }> = [];
  for (const index of candidates) {
    if (accepted.some((t) => t.index === index)) continue;
    const anchor: ChartTick["anchor"] = index === 0 ? "start" : index === n - 1 ? "end" : "middle";
    const x = marginPx + slot * (index + 0.5);
    const w = (labels[index] ?? "").length * CHAR_PX;
    const from = anchor === "start" ? x : anchor === "end" ? x - w : x - w / 2;
    const to = from + w;
    if (anchor === "middle" && (from < 0 || to > widthPx)) continue;
    if (accepted.some((t) => from < t.to + 4 && to > t.from - 4)) continue;
    accepted.push({ index, anchor, from, to });
  }
  return accepted.sort((a, b) => a.index - b.index).map(({ index, anchor }) => ({ index, anchor }));
}

/**
 * Which bars get a value label. Larger values claim their spot first (so the peak is always
 * labelled); a label is dropped when its centre is under `minGapPx` from an accepted one, or the two
 * would touch at their widths.
 */
export function valueLabelIndexes(values: number[], slotPx: number, minGapPx = 10): Set<number> {
  const width = (v: number) => v.toLocaleString().length * CHAR_PX;
  const shown: number[] = [];
  const byValue = values
    .map((v, i) => [v, i] as const)
    .filter(([v]) => v > 0)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [v, i] of byValue) {
    const fits = shown.every((j) => Math.abs(j - i) * slotPx >= Math.max(minGapPx, (width(v) + width(values[j]!)) / 2 + 2));
    if (fits) shown.push(i);
  }
  return new Set(shown);
}
