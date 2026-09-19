/**
 * How seriously someone read something, in one word.
 *
 * A row that says "9 pages · 1m 20s" makes the reader do arithmetic before they know whether it is
 * worth opening. This turns the same two numbers into the judgement they were doing in their head:
 * nine pages in eighty seconds is a skim, one page for four minutes is not.
 *
 * Two axes, because one lies. **Dwell** is how long they spent per page; **coverage** is how much
 * of the document they opened at all. Thirty seconds on one page is attentive on a one-pager and
 * abandonment on a nine-page deck, and calling both "Read" is the kind of false comfort that gets
 * someone to stop chasing a deal they should chase.
 *
 *   dwell high, coverage high  → Read      — they went through it properly
 *   dwell low,  coverage high  → Skimmed   — they turned every page fast
 *   dwell high, coverage low   → Started   — they stopped early, but they were reading
 *   dwell low,  coverage low   → Glanced   — opened and gone
 *
 * The thresholds are deliberately coarse. There is no honest way to tell "read carefully" from
 * "left the tab open" with a clock alone, so the vocabulary stops where the data does, and the
 * tooltip always says the raw figures so nobody has to trust the label over the numbers.
 *
 * Coverage is only applied when the document's page count is known. On a project — where the unit
 * is documents opened, not pages — there is no denominator worth having, so dwell decides alone.
 */
export type ReadingDepth = "read" | "skimmed" | "started" | "glanced" | "unknown";

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
/**
 * Below this share of the document, "Read" is not available however long they stayed on what they
 * did open — a third is the line between "stopped early" and "went through it".
 */
const COVERAGE_FOR_READ = 1 / 3;

export function readingDepth(input: {
  timeMs: number | null | undefined;
  pages: number | null | undefined;
  /** The document's page count, when it is known. Absent on projects and on unpaged files. */
  totalPages?: number | null;
}): ReadingDepth {
  const timeMs = typeof input.timeMs === "number" && Number.isFinite(input.timeMs) ? Math.max(0, input.timeMs) : 0;
  const pages = typeof input.pages === "number" && Number.isFinite(input.pages) ? Math.max(0, Math.floor(input.pages)) : 0;

  // No clock at all: visits recorded before the reading clock, and arrivals that opened nothing.
  if (timeMs <= 0) return "unknown";
  if (timeMs < GLANCE_TOTAL_MS) return "glanced";

  const perPage = pages > 0 ? timeMs / pages : timeMs;
  const deep = perPage >= READ_PER_PAGE_MS || (timeMs >= READ_TOTAL_MS && perPage >= READ_TOTAL_PER_PAGE_MS);

  const totalPages =
    typeof input.totalPages === "number" && Number.isFinite(input.totalPages) ? Math.max(0, Math.floor(input.totalPages)) : 0;
  // A one-page document is fully covered by definition; so is a document we cannot measure.
  const covered = totalPages > 1 && pages > 0 ? pages / totalPages : 1;
  const broad = covered >= COVERAGE_FOR_READ;

  if (deep) return broad ? "read" : "started";
  return "skimmed";
}

/** The word, and how loudly to say it. `unknown` is deliberately silent. */
export const READING_DEPTH_LABEL: Record<ReadingDepth, string> = {
  read: "Read",
  skimmed: "Skimmed",
  started: "Started",
  glanced: "Glanced",
  unknown: "",
};

/**
 * Tailwind classes per tier, muted on purpose: this sits beside a name, and a traffic light there
 * would out-shout the person it describes. Green means "worth your time", not "good".
 */
export const READING_DEPTH_CLASS: Record<ReadingDepth, string> = {
  read: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/20 dark:text-emerald-300",
  // Attentive but incomplete: worth a follow-up, so it is marked rather than muted — amber, which
  // this product otherwise spends only on starred, is deliberately not used; this is sky.
  started: "bg-sky-500/10 text-sky-700 ring-sky-500/20 dark:text-sky-300",
  skimmed: "bg-[var(--panel-hover)] text-[var(--muted)] ring-[var(--border)]",
  glanced: "bg-[var(--panel-hover)] text-[var(--muted-2)] ring-[var(--border)]",
  unknown: "",
};
