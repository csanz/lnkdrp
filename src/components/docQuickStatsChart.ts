/** Layout math for the side panel's people-by-day bars, kept pure so it can be tested without a DOM. */

/** `dx`: where the label's anchor sits relative to the bar centre (recharts places ticks at the centre). */
export type ChartTick = { index: number; anchor: "start" | "middle" | "end"; dx: number };

/** Rough rendered width of a 10px label; generous so near-misses count as collisions. */
const CHAR_PX = 6;
/** An active stretch at most this many days long outranks the range's first day for a tick. */
const SHORT_SPAN_DAYS = 7;

/**
 * X-axis ticks: the first and last day, plus the midpoint — or, when activity sits in a narrow
 * stretch (under a third of the range), the first and last active day instead, so a cluster of bars
 * has a date beside it that matches "Last opened". Ticks that would overlap an earlier-chosen tick
 * or spill past the chart are dropped; the order of `candidates` is the priority.
 *
 * The range's edge labels align to the chart edges. A first active day whose centred label collides
 * is retried to the left of its cluster (right edge at the bar's left edge), which is what lets a
 * cluster ending today show both of its dates. For a stretch of at most a week the cluster's dates
 * outrank the range's first day, which is dropped when it would collide with them.
 */
export function chartTicks(values: number[], labels: string[], widthPx: number, marginPx = 2): ChartTick[] {
  const n = values.length;
  if (!n) return [];
  const slot = Math.max(0, widthPx - 2 * marginPx) / n;
  const nonZero = values.flatMap((v, i) => (v > 0 ? [i] : []));
  const firstActive = nonZero[0];
  const lastActive = nonZero[nonZero.length - 1];
  const span = firstActive !== undefined && lastActive !== undefined ? lastActive - firstActive + 1 : n;
  const narrow = span < n / 3;
  const short = narrow && span <= SHORT_SPAN_DAYS;
  const candidates = narrow
    ? short
      ? [n - 1, lastActive!, firstActive!, 0]
      : [0, n - 1, lastActive!, firstActive!]
    : [0, n - 1, Math.floor((n - 1) / 2)];

  const accepted: Array<ChartTick & { from: number; to: number }> = [];
  const place = (index: number, anchor: ChartTick["anchor"], labelX: number) => {
    const center = marginPx + slot * (index + 0.5);
    const w = (labels[index] ?? "").length * CHAR_PX;
    const from = anchor === "start" ? labelX : anchor === "end" ? labelX - w : labelX - w / 2;
    const to = from + w;
    if (from < 0 || to > widthPx) return false;
    if (accepted.some((t) => from < t.to + 4 && to > t.from - 4)) return false;
    accepted.push({ index, anchor, dx: labelX - center, from, to });
    return true;
  };
  for (const index of candidates) {
    if (accepted.some((t) => t.index === index)) continue;
    if (index === 0) place(index, "start", marginPx);
    else if (index === n - 1) place(index, "end", widthPx - marginPx);
    else if (!place(index, "middle", marginPx + slot * (index + 0.5)) && index === firstActive) {
      place(index, "end", marginPx + slot * index);
    }
  }
  return accepted.sort((a, b) => a.index - b.index).map(({ index, anchor, dx }) => ({ index, anchor, dx }));
}

/**
 * Which bars get a value label: every non-zero bar when all of their labels fit, otherwise only the
 * peak. Partial labelling read as a sum that did not add up to People, and a greedy pass labelled
 * small far-off bars while the second-tallest bar beside the peak went blank. Two labels collide when
 * their centres are under `minGapPx` apart or they would touch at their widths.
 */
export function valueLabelIndexes(values: number[], slotPx: number, minGapPx = 10): Set<number> {
  const width = (v: number) => v.toLocaleString().length * CHAR_PX;
  const byValue = values
    .map((v, i) => [v, i] as const)
    .filter(([v]) => v > 0)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const shown: number[] = [];
  for (const [v, i] of byValue) {
    const fits = shown.every((j) => Math.abs(j - i) * slotPx >= Math.max(minGapPx, (width(v) + width(values[j]!)) / 2 + 2));
    if (!fits) return new Set([byValue[0]![1]]);
    shown.push(i);
  }
  return new Set(shown);
}

/**
 * The smallest contiguous run of days holding at least `share` of all people, for the caption that
 * stands in for the bar labels a tight cluster has no room for. Among equally short runs the one with
 * more people wins, then the earlier one. Null when nobody is counted.
 */
export function peopleCluster(values: number[], share = 0.9): { from: number; to: number; people: number; total: number } | null {
  const total = values.reduce((a, v) => a + Math.max(0, v), 0);
  if (total <= 0) return null;
  const need = total * share;
  let best: { from: number; to: number; people: number } | null = null;
  let sum = 0;
  let from = 0;
  for (let to = 0; to < values.length; to++) {
    sum += Math.max(0, values[to]!);
    // Shrink from the left while the run still holds enough people.
    while (from < to && sum - Math.max(0, values[from]!) >= need - 1e-9) {
      sum -= Math.max(0, values[from]!);
      from++;
    }
    if (sum >= need - 1e-9) {
      const len = to - from;
      if (!best || len < best.to - best.from || (len === best.to - best.from && sum > best.people)) best = { from, to, people: sum };
    }
  }
  return best ? { ...best, total } : null;
}
