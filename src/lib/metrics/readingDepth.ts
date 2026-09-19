/**
 * How seriously someone read something, in one word.
 *
 * A row that says "9 pages · 1m 20s" makes the reader do arithmetic before they know whether it is
 * worth opening. This turns the same two numbers into the judgement they were doing in their head:
 * nine pages in eighty seconds is a skim, one page for four minutes is not.
 *
 * The thresholds are deliberately coarse. There is no honest way to tell "read carefully" from
 * "left the tab open" with a clock alone, so the vocabulary stops where the data does: three tiers
 * plus "we do not know", and the tooltip always says the raw figures so nobody has to trust the
 * label over the numbers.
 */
export type ReadingDepth = "read" | "skimmed" | "glanced" | "unknown";

/** Under this, a visit is a glance however many pages it touched. */
const GLANCE_TOTAL_MS = 10_000;
/** At or over this per page, someone was reading, however short the visit. */
const READ_PER_PAGE_MS = 15_000;
/**
 * A long visit also counts as reading — but only if it was not spread thin.
 *
 * Nine pages in eighty seconds passes a total-time test and is plainly a skim: nine seconds a page
 * is the speed of looking for something, not of reading it. So the long-visit route carries its
 * own pace floor rather than letting duration alone earn the word.
 */
const READ_TOTAL_MS = 60_000;
const READ_TOTAL_PER_PAGE_MS = 10_000;

export function readingDepth(input: { timeMs: number | null | undefined; pages: number | null | undefined }): ReadingDepth {
  const timeMs = typeof input.timeMs === "number" && Number.isFinite(input.timeMs) ? Math.max(0, input.timeMs) : 0;
  const pages = typeof input.pages === "number" && Number.isFinite(input.pages) ? Math.max(0, Math.floor(input.pages)) : 0;

  // No clock at all: visits recorded before the reading clock, and arrivals that opened nothing.
  if (timeMs <= 0) return "unknown";
  if (timeMs < GLANCE_TOTAL_MS) return "glanced";

  const perPage = pages > 0 ? timeMs / pages : timeMs;
  if (perPage >= READ_PER_PAGE_MS) return "read";
  if (timeMs >= READ_TOTAL_MS && perPage >= READ_TOTAL_PER_PAGE_MS) return "read";
  return "skimmed";
}

/** The word, and how loudly to say it. `unknown` is deliberately silent. */
export const READING_DEPTH_LABEL: Record<ReadingDepth, string> = {
  read: "Read",
  skimmed: "Skimmed",
  glanced: "Glanced",
  unknown: "",
};

/**
 * Tailwind classes per tier, muted on purpose: this sits beside a name, and a traffic light there
 * would out-shout the person it describes. Green means "worth your time", not "good".
 */
export const READING_DEPTH_CLASS: Record<ReadingDepth, string> = {
  read: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/20 dark:text-emerald-300",
  skimmed: "bg-[var(--panel-hover)] text-[var(--muted)] ring-[var(--border)]",
  glanced: "bg-[var(--panel-hover)] text-[var(--muted-2)] ring-[var(--border)]",
  unknown: "",
};
