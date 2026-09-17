import { CALLOUT_MIN_PEOPLE, READ_MIN_MS, VERDICT_LONGEST_MIN_MS, VERDICT_READ_MEDIAN_MS } from "./constants";
import { coverSummedAcrossVisits, largestReturn, pickStandout } from "./attention";
import { dwellRatio, formatDwell, formatReturnGap } from "./format";
import { median } from "./pageTable";
import type { Person, Verdict } from "./types";

export type { Verdict } from "./types";

/** A standout page must hold the person this many times longer than their next-longest page. */
const LONGEST_MARGIN = 1.1;
const STANDOUT_MULTIPLIER = 2;
/** Out-of-order paths longer than this are summarised as a count. */
const PATH_LIST_MAX = 4;
const NBSP = "\u00a0";

/** The page table's figures for one page. */
export type PageTypical = { typicalMs: number | null; readCount: number };

export type VerdictOptions = {
  /** IANA zone for "came back the next day"; this runtime's zone when omitted. */
  tz?: string;
  /** The page table's typical time and stayed count for a page (the same figures the table shows). */
  typicalFor?: (page: number) => PageTypical | null;
};

/**
 * One-line summary of how far a person got (coverage) and the most telling thing they did
 * (behaviour). "Read" appears only when every page was stayed on and the median stop is 10s or more.
 * `labels` gives the short page name appended to a page the behaviour names.
 */
export function buildVerdict(p: Person, P: number, labels?: (page: number) => string | null, opts: VerdictOptions = {}): Verdict {
  const downloaded = p.downloads > 0 ? " Downloaded it." : "";
  if (!p.hasDetail) return { coverage: null, behaviour: null, text: `No page detail was recorded for this person.${downloaded}`, page: null };

  const coverage = coverageFor(p, P);
  const b = behaviourFor(p, labels, opts);
  const behaviour = b?.text ?? null;
  return { coverage, behaviour, text: `${behaviour ? `${coverage}. ${behaviour}.` : `${coverage}.`}${downloaded}`, page: b?.page ?? null };
}

/** "page 4" / "pages 2–9" with a no-break space, so the number never wraps away from the word. */
function pg(n: number | string): string {
  return `page${NBSP}${n}`;
}

function pgs(list: string): string {
  return `pages${NBSP}${list}`;
}

function coverageFor(p: Person, P: number): string {
  const stopMs = p.visits.flatMap((v) => v.stops.map((s) => s.ms));
  const medianStopMs = median(stopMs) ?? 0;
  const allRead = p.cells.length > 0 && p.cells.every((c) => c.state === "read");
  const readAll = allRead && medianStopMs >= VERDICT_READ_MEDIAN_MS;

  if (P === 1) return readAll ? "Read the only page" : "Went through the only page";
  if (p.reachedCount === P) return readAll ? `Read all ${P} pages` : `Went through all ${P} pages`;
  if (p.maxPage === 1) return `Left on ${pg(1)}`;

  const lastState = p.cells[P - 1]?.state;
  // Only a last page that was stayed on (or whose time is unknown) counts as reaching it; a flick past it does not.
  if (p.maxPage === P && p.reachedCount < p.maxPage && (lastState === "read" || lastState === "unknown")) {
    return `Reached the last page, skipping ${skippedText(p, P)}`;
  }
  const exit = p.exitPage;
  if (exit !== null && exit < p.maxPage) {
    const path = latestPath(p);
    if (path && !isAscending(path)) {
      const order = lastAppearanceOrder(path);
      const listed = order[0] === 1 ? order.slice(1) : order;
      if (listed.length > PATH_LIST_MAX) return `Jumped around ${order.length} pages and left on ${pg(exit)}`;
      if (listed.length >= 2) return `Went to ${pgs(joinList(listed.map(String)))} out of order and left on ${pg(exit)}`;
    }
    const skipping = p.reachedCount < p.maxPage ? `, skipping ${skippedText(p, P)},` : "";
    return `Got as far as ${pg(p.maxPage)} of ${P}${skipping} and left on ${pg(exit)}`;
  }
  if (p.reachedCount < p.maxPage) return `Jumped to ${pg(p.maxPage)} of ${P}, skipping ${skippedText(p, P)}`;
  return `Stopped at ${pg(p.maxPage)} of ${P}`;
}

/** The latest visit's stop pages with consecutive repeats collapsed, ending on its exit page. */
function latestPath(p: Person): number[] | null {
  const v = p.latestVisit;
  if (!v) return null;
  const path: number[] = [];
  for (const s of v.stops) if (path[path.length - 1] !== s.page) path.push(s.page);
  if (v.exitPage !== null && path[path.length - 1] !== v.exitPage) path.push(v.exitPage);
  return path;
}

function isAscending(path: number[]): boolean {
  return path.every((page, i) => i === 0 || page > path[i - 1]);
}

/** Distinct pages ordered by where each last appears, so the exit page comes last. */
function lastAppearanceOrder(path: number[]): number[] {
  const out: number[] = [];
  for (let i = path.length - 1; i >= 0; i--) if (!out.includes(path[i])) out.unshift(path[i]);
  return out;
}

function joinList(parts: string[]): string {
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : (parts[0] ?? "");
}

/** "pages 2–9", "page 4", "pages 2–3 and 7–9"; more than two runs → "5 of 12 pages". */
function skippedText(p: Person, P: number): string {
  const seen = new Set(p.seen);
  const runs: Array<[number, number]> = [];
  let total = 0;
  for (let page = 1; page < p.maxPage; page++) {
    if (seen.has(page)) continue;
    total += 1;
    const last = runs[runs.length - 1];
    if (last && last[1] === page - 1) last[1] = page;
    else runs.push([page, page]);
  }
  if (runs.length > 2) return `${total} of ${P} pages`;
  const joined = joinList(runs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)));
  return total === 1 ? pg(joined) : pgs(joined);
}

/** formatDwell with non-breaking spaces, so "1m 10s" never wraps inside a sentence. */
function dur(ms: number): string {
  return formatDwell(ms).replace(/ /g, NBSP);
}

type Behaviour = { text: string; page: number | null };

/** kind "typical": above the page's typical time (ratio null below CALLOUT_MIN_PEOPLE stayers); "longest": the person's own clearly longest page. */
type Standout = { kind: "typical" | "longest"; page: number; ms: number; ratio: number | null };

function behaviourFor(p: Person, labels: ((page: number) => string | null) | undefined, opts: VerdictOptions): Behaviour | null {
  const L = (k: number) => {
    const label = labels?.(k) ?? null;
    return label ? ` (${label})` : "";
  };
  const ratioClause = (s: Standout) => (s.ratio !== null ? `, ${s.ratio.toFixed(1)}× the typical time` : "");

  const ret = largestReturn(p);
  const standout = standoutPage(p, opts.typicalFor);

  if (ret !== null) {
    const came = `Came back ${formatReturnGap(ret.fromMs, ret.toMs, opts.tz)}`;
    if (!standout) return { text: came, page: null };
    return { text: `${came} and spent ${dur(standout.ms)} on ${pg(standout.page)}${L(standout.page)}${ratioClause(standout)}`, page: standout.page };
  }

  if (standout) {
    const k = standout.page;
    if (standout.kind === "typical") {
      const tail = standout.ratio !== null ? ratioClause(standout) : k === p.exitPage ? ", then left" : "";
      return { text: `Spent ${dur(standout.ms)} on ${pg(k)}${L(k)}${tail}`, page: k };
    }
    if (k === p.exitPage) return { text: `Spent ${dur(standout.ms)} on ${pg(k)}${L(k)}, then left`, page: k };
    const label = L(k);
    return { text: label ? `Spent longest on ${pg(k)}${label}, ${dur(standout.ms)}` : `Spent longest on ${pg(k)} (${dur(standout.ms)})`, page: k };
  }

  let back = 0;
  p.revisitsByPage.forEach((n, i) => {
    if (n < 1) return;
    const page = i + 1;
    if (
      back === 0 ||
      n > p.revisitsByPage[back - 1] ||
      (n === p.revisitsByPage[back - 1] && p.dwellByPage[i] > p.dwellByPage[back - 1])
    ) {
      back = page;
    }
  });
  if (back > 0) return { text: `Went back to ${pg(back)}${L(back)}`, page: back };

  const passed = p.cells
    .map((c, i) => ({ page: i + 1, c }))
    .filter(({ page, c }) => c.state === "passed" && c.ms < READ_MIN_MS && page < p.maxPage)
    .map(({ page }) => page);
  let bestA = 0;
  let bestB = -1;
  for (let i = 0; i < passed.length; ) {
    let j = i;
    while (j + 1 < passed.length && passed[j + 1] === passed[j] + 1) j++;
    if (passed[j] - passed[i] > bestB - bestA) {
      bestA = passed[i];
      bestB = passed[j];
    }
    i = j + 1;
  }
  if (bestB >= bestA && bestA > 0) {
    return { text: bestA === bestB ? `Passed over ${pg(bestA)} quickly` : `Passed over ${pgs(`${bestA}–${bestB}`)} quickly`, page: null };
  }
  return null;
}

/**
 * The page that held this person: (a) the stayed page furthest above the page table's typical time
 * for it (≥ 2× and ≥ VERDICT_LONGEST_MIN_MS; the longest of pages within 10% of the top ratio), else (b) their clearly longest page, ≥ 2× their own
 * median, ≥ VERDICT_LONGEST_MIN_MS and ≥ 1.1× their next-longest page, so a near tie names no page.
 * Page 1 is left out when its time was summed over several visits (each return lands on it).
 */
function standoutPage(p: Person, typicalFor?: (page: number) => PageTypical | null): Standout | null {
  const dwell = coverSummedAcrossVisits(p) ? p.dwellByPage.map((ms, i) => (i === 0 ? 0 : ms)) : p.dwellByPage;

  if (typicalFor) {
    const candidates: Array<{ page: number; ms: number; ratio: number; readCount: number }> = [];
    for (let i = 0; i < p.cells.length; i++) {
      const c = p.cells[i];
      if (c.state !== "read" || dwell[i] === 0 || c.ms < VERDICT_LONGEST_MIN_MS) continue;
      const t = typicalFor(i + 1);
      if (!t || t.typicalMs === null || t.typicalMs <= 0 || c.ms < STANDOUT_MULTIPLIER * t.typicalMs) continue;
      const ratio = dwellRatio(c.ms, t.typicalMs);
      candidates.push({ page: i + 1, ms: c.ms, ratio, readCount: t.readCount });
    }
    const best = pickStandout(candidates, (x) => x.ratio);
    if (best) return { kind: "typical", page: best.page, ms: best.ms, ratio: best.readCount >= CALLOUT_MIN_PEOPLE ? best.ratio : null };
  }

  const positive = dwell.filter((ms) => ms > 0);
  if (positive.length < 2) return null;
  let k = 1;
  dwell.forEach((ms, i) => {
    if (ms > dwell[k - 1]) k = i + 1;
  });
  const dwellK = dwell[k - 1];
  const others = dwell.filter((ms, i) => ms > 0 && i !== k - 1);
  // Page k is left out of its own baseline; with two timed pages it would otherwise be half of it.
  const personMedian = median(others) ?? 0;
  const second = Math.max(0, ...others);
  if (dwellK < STANDOUT_MULTIPLIER * personMedian || dwellK < VERDICT_LONGEST_MIN_MS || dwellK < LONGEST_MARGIN * second) return null;
  return { kind: "longest", page: k, ms: dwellK, ratio: null };
}
