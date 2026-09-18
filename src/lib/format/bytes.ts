/**
 * Byte-size formatting, shared by every surface that shows a file's own facts.
 *
 * Written for the version history and the document page: an owner who replaced a 3.5MB deck with a
 * 1.7MB optimized one should be able to see that, and the number has to read the same way in the
 * history list, the "What changed" modal and the document's side panel.
 *
 * Rules that the callers rely on:
 * - Unknown/invalid input is `null`, never "0 B" and never "NaN" — a version whose upload row has
 *   no recorded size simply shows nothing rather than claiming the file is empty.
 * - The delta needs BOTH sizes. The first version (and any old row with no previous size) has no
 *   delta, so `sizeDelta()` returns `null` there.
 */

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** A real minus sign (U+2212), not a hyphen: it lines up with digits in tabular numbers. */
const MINUS = "−";

/**
 * Coerce an unknown value into a size in bytes, or `null`.
 *
 * `0` is a valid size for the purposes of arithmetic but never something we render on its own, so
 * callers get it back here and `formatBytes` is the one that declines to print it.
 */
export function toBytes(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * Format a size in bytes for display ("1.7 MB", "820 KB"), or `null` when there is nothing to show.
 *
 * Binary units (1024), matching how a file manager reports the same PDF. Bytes and kilobytes get no
 * decimal (a "1.0 KB" file reads as a rounding artifact); megabytes and up get one.
 */
export function formatBytes(value: unknown): string | null {
  const bytes = toBytes(value);
  if (bytes === null || bytes <= 0) return null;
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i += 1;
  }
  const digits = i <= 1 ? 0 : 1;
  return `${v.toFixed(digits)} ${UNITS[i]}`;
}

export type SizeDelta = {
  /** Signed difference in bytes (negative = the new file is smaller). */
  bytes: number;
  /** Which way it went; `"same"` when the two versions weigh exactly the same. */
  direction: "smaller" | "larger" | "same";
  /** The magnitude with a sign ("−1.8 MB", "+420 KB"), or `null` when nothing changed. */
  label: string | null;
  /** The same change as a percentage of the previous size, or `null` when nothing changed. */
  percent: string | null;
};

/**
 * The change between two versions of the same file, or `null` when either size is unknown.
 *
 * The percentage is of the PREVIOUS size, so "−49%" means "half the weight it used to be".
 * A previous size of 0 has no meaningful percentage, so only the byte label comes back.
 */
export function sizeDelta(previous: unknown, next: unknown): SizeDelta | null {
  const from = toBytes(previous);
  const to = toBytes(next);
  if (from === null || to === null) return null;

  const diff = to - from;
  if (diff === 0) return { bytes: 0, direction: "same", label: null, percent: null };

  const magnitude = formatBytes(Math.abs(diff));
  // A difference under a byte cannot happen with integer sizes, but a caller passing floats could
  // land here; treat anything that does not format as "no visible change" rather than printing "0 B".
  if (!magnitude) return { bytes: 0, direction: "same", label: null, percent: null };

  const sign = diff < 0 ? MINUS : "+";
  const pctValue = from > 0 ? (diff / from) * 100 : null;
  const percent =
    pctValue === null
      ? null
      : (function () {
          const abs = Math.abs(pctValue);
          // Below 0.5% the rounded number would be "0%", which reads as "nothing happened".
          if (abs < 0.5) return null;
          return `${sign}${Math.round(abs)}%`;
        })();

  return {
    bytes: diff,
    direction: diff < 0 ? "smaller" : "larger",
    label: `${sign}${magnitude}`,
    percent,
  };
}

/**
 * The one quiet line the history entries show: the new size, then how it moved.
 *
 * - No new size at all -> `null` (render nothing).
 * - No previous size (first version, or an old upload row) -> just the size.
 * - Same size -> the size plus "no change", so the line does not look truncated.
 */
export function formatSizeChangeLine(previous: unknown, next: unknown): string | null {
  const size = formatBytes(next);
  if (!size) return null;
  const delta = sizeDelta(previous, next);
  if (!delta) return size;
  if (delta.direction === "same") return `${size} · no change`;
  const change = delta.percent ? `${delta.label} (${delta.percent})` : delta.label;
  return `${size} · ${change}`;
}

/** "12 pages" / "1 page", or `null` when the page count was never recorded. */
export function formatPageCount(value: unknown): string | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 1) return null;
  const pages = Math.floor(n);
  return `${pages} page${pages === 1 ? "" : "s"}`;
}
