/**
 * Shade scale for ReadingMatrix cells.
 *
 * `cellStep` buckets time on a page into fixed absolute steps, so a 10s cell looks the same on
 * every document and one long outlier cannot flatten everyone else. `cellOpacity` is the older
 * relative log scale, kept for existing callers.
 */

export type CellStep = 0 | 1 | 2 | 3 | 4 | 5;

/** Lower bound (ms) of steps 1..5. */
export const CELL_STEP_FLOORS_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;

/** Legend labels for steps 1..5. */
export const CELL_STEP_LABELS = ["2s", "5s", "15s", "30s", "1m+"] as const;

/** 0 (<2s), 1 (2–5s), 2 (5–15s), 3 (15–30s), 4 (30–60s), 5 (60s+). */
export function cellStep(ms: number): CellStep {
  if (!Number.isFinite(ms)) return 0;
  let step = 0;
  for (const floor of CELL_STEP_FLOORS_MS) if (ms >= floor) step += 1;
  return step as CellStep;
}

const LIGHT_RAMP = ["#d1fae5", "#6ee7b7", "#10b981", "#047857", "#064e3b"];
const LIGHT_TEXT = ["#065f46", "#064e3b", "#022c22", "#ecfdf5", "#ecfdf5"];
const DARK_RAMP = ["#064e3b", "#047857", "#10b981", "#34d399", "#a7f3d0"];
const DARK_TEXT = ["#a7f3d0", "#d1fae5", "#022c22", "#022c22", "#022c22"];

function rampVars(fill: string[], text: string[]): string {
  return fill.map((c, i) => `--mx-${i + 1}:${c};--mx-t-${i + 1}:${text[i]};`).join("");
}

/**
 * `--mx-1..5` (fill) and `--mx-t-1..5` (text on that fill) for `[data-mx-ramp]`. Light goes pale to
 * deep and dark goes deep to bright, so more time always means more contrast with the card.
 * Covers the explicit theme attribute and the system preference when no theme is set.
 */
export const MATRIX_RAMP_CSS =
  `[data-mx-ramp]{${rampVars(LIGHT_RAMP, LIGHT_TEXT)}}` +
  `:root[data-theme="dark"] [data-mx-ramp]{${rampVars(DARK_RAMP, DARK_TEXT)}}` +
  `@media (prefers-color-scheme: dark){:root:not([data-theme]) [data-mx-ramp]{${rampVars(DARK_RAMP, DARK_TEXT)}}}`;

/**
 * Time printed inside a matrix cell: whole seconds up to 999s ("118s"), so neighbouring cells share
 * one unit and a longer stay never prints as a smaller number; then minutes to one decimal ("17.3m"),
 * then whole hours.
 */
export function formatCellDwell(ms: number): string {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (safe < 1_000_000) return `${Math.floor(safe / 1000)}s`;
  if (safe < 3_600_000) return `${(Math.floor(safe / 6_000) / 10).toFixed(1)}m`;
  return `${Math.floor(safe / 3_600_000)}h`;
}

/** Opacity (0..1, two decimals) for a stayed cell with `ms` dwell against the matrix maximum. */
export function cellOpacity(ms: number, maxMs: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  if (!Number.isFinite(maxMs) || maxMs <= 0) return 1;
  const r = Math.log1p(ms / 1000) / Math.log1p(maxMs / 1000);
  const v = 0.18 + 0.82 * Math.min(1, r);
  return Math.round(v * 100) / 100;
}
