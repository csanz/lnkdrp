/**
 * Share formatting for the actor donut.
 *
 * The arcs themselves are recharts' `<Pie>`, like every other chart in the app; this is the one
 * piece of maths the chart library does not do for us the way the legend needs it.
 */

/** "42%" for a share, rounded, with no slice that has any value ever shown as 0%. */
export function formatShare(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return "0%";
  const pct = share * 100;
  return `${pct < 1 ? "<1" : Math.round(pct)}%`;
}
