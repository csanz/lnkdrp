/**
 * Shade scale for ReadingMatrix cells. Log scale so a 10-minute outlier does not wash every
 * other stayed cell out to the floor; the floor keeps a 2s cell visibly filled.
 */

/** Opacity (0..1, two decimals) for a stayed cell with `ms` dwell against the matrix maximum. */
export function cellOpacity(ms: number, maxMs: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  if (!Number.isFinite(maxMs) || maxMs <= 0) return 1;
  const r = Math.log1p(ms / 1000) / Math.log1p(maxMs / 1000);
  const v = 0.18 + 0.82 * Math.min(1, r);
  return Math.round(v * 100) / 100;
}
