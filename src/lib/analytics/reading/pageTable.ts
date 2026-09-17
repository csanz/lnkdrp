import { CALLOUT_MIN_COUNT, CALLOUT_MIN_PEOPLE, TYPICAL_MIN_READERS } from "./constants";
import type { Callouts, PageMeta, PageRow, Person } from "./types";

export type { Callouts, PageRow } from "./types";

/** Median with even counts floored to an integer midpoint; null for an empty list. */
export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : Math.floor((s[mid - 1] + s[mid]) / 2);
}

/** Per-page reach, stayed count, typical time, passed, jumped and left-here over people with page detail. */
export function computePageTable(peopleWithDetail: Person[], P: number, meta: PageMeta[]): PageRow[] {
  const metaByPage = new Map(meta.map((m) => [m.page, m]));
  const rows: PageRow[] = [];
  for (let page = 1; page <= P; page++) {
    let reached = 0;
    let passed = 0;
    let jumped = 0;
    let leftHere = 0;
    let stillReading = 0;
    const readDwell: number[] = [];
    for (const person of peopleWithDetail) {
      const cell = person.cells[page - 1];
      if (cell && cell.state !== "unreached" && cell.state !== "jumped") reached += 1;
      if (cell?.state === "read") readDwell.push(cell.ms);
      if (cell?.state === "passed") passed += 1;
      if (cell?.state === "jumped") jumped += 1;
      if (person.exitPage === page) leftHere += 1;
      if (person.maxPage >= page) stillReading += 1;
    }
    const m = metaByPage.get(page);
    const readCount = readDwell.length;
    rows.push({
      page,
      label: m?.label ?? null,
      shortLabel: m?.shortLabel ?? m?.label ?? null,
      thumbUrl: m?.thumbUrl ?? null,
      reached,
      readCount,
      typicalMs: readCount >= TYPICAL_MIN_READERS ? median(readDwell) : null,
      fewMs: readCount >= 1 && readCount < TYPICAL_MIN_READERS ? [...readDwell].sort((a, b) => b - a) : null,
      passed,
      jumped,
      leftHere,
      stillReading,
    });
  }
  return rows;
}

/** More than this many pages tied on a highlight means none of them stands out. */
const CALLOUT_MAX_TIED = 3;
/** Pages whose typical time is within this share of the longest are shown as tied with it. */
const HELD_TIE_SHARE = 0.95;
/** The longest-held page must be this many times the median typical time of the eligible pages. */
const HELD_MIN_LIFT = 1.25;

/** Highlights for the page table; null below CALLOUT_MIN_PEOPLE people with page detail. */
export function computeCallouts(rows: PageRow[], peopleWithDetail: number, P: number): Callouts | null {
  if (peopleWithDetail < CALLOUT_MIN_PEOPLE) return null;

  // A typical time from fewer people than the gate can be one person's own time.
  let held: PageRow | null = null;
  for (const r of rows) {
    if (r.typicalMs === null || r.readCount < CALLOUT_MIN_PEOPLE) continue;
    if (
      !held ||
      r.typicalMs > (held.typicalMs as number) ||
      (r.typicalMs === held.typicalMs && (r.readCount > held.readCount || (r.readCount === held.readCount && r.page < held.page)))
    ) {
      held = r;
    }
  }

  // The cover is where everyone starts, so a few quick flips past it say nothing about the page.
  const skipCandidates = rows
    .map((r) => ({ page: r.page, skipped: r.passed + r.jumped, of: r.stillReading }))
    .filter((c) => c.skipped >= CALLOUT_MIN_COUNT && c.of > 0 && !(P > 2 && c.page === 1))
    .sort((a, b) => b.skipped * a.of - a.skipped * b.of || b.skipped - a.skipped || a.page - b.page);
  let mostSkipped: Callouts["mostSkipped"] = null;
  if (skipCandidates.length > 0) {
    const top = skipCandidates[0];
    const tiedPages = skipCandidates.filter((c) => c.skipped === top.skipped && c.of === top.of).map((c) => c.page).sort((a, b) => a - b);
    if (tiedPages.length <= CALLOUT_MAX_TIED) mostSkipped = { page: top.page, skipped: top.skipped, of: top.of, tiedPages };
  }

  let mostLeft: Callouts["mostLeft"] = null;
  if (P > 1) {
    const leftCandidates = rows
      .filter((r) => r.page >= 1 && r.page <= P - 1 && r.leftHere >= CALLOUT_MIN_COUNT)
      .sort((a, b) => b.leftHere - a.leftHere || a.page - b.page);
    if (leftCandidates.length > 0) {
      const top = leftCandidates[0];
      const tiedPages = leftCandidates.filter((r) => r.leftHere === top.leftHere).map((r) => r.page).sort((a, b) => a - b);
      if (tiedPages.length <= CALLOUT_MAX_TIED) mostLeft = { page: top.page, leftHere: top.leftHere, people: peopleWithDetail, tiedPages };
    }
  }

  const { heldLongest, heldFlat } = held ? heldLongestFor(rows, held, P) : { heldLongest: null, heldFlat: null };
  return { heldLongest, heldFlat, mostSkipped, mostLeft };
}

const typicalsOf = (rs: PageRow[]) => rs.map((r) => r.typicalMs as number);

/**
 * The held-longest highlight, or null when it would not single anything out: more tied pages than
 * min(CALLOUT_MAX_TIED, a third of the document), or a leader under HELD_MIN_LIFT× the median typical
 * time of the pages enough people stayed on. When it is null over two or more eligible pages,
 * `heldFlat` says why, so the slot can explain the flat result instead of vanishing.
 */
function heldLongestFor(rows: PageRow[], held: PageRow, P: number): Pick<Callouts, "heldLongest" | "heldFlat"> {
  const leaderMs = held.typicalMs as number;
  const eligible = rows.filter((r) => r.typicalMs !== null && r.readCount >= CALLOUT_MIN_PEOPLE);
  const tiedRows = eligible.filter((r) => r.page === held.page || (r.typicalMs as number) >= HELD_TIE_SHARE * leaderMs).sort((a, b) => a.page - b.page);
  const canExplain = eligible.length >= 2;
  if (tiedRows.length > Math.min(CALLOUT_MAX_TIED, Math.max(1, Math.floor(P / 3)))) {
    const tiedSet = new Set(tiedRows.map((r) => r.page));
    const heldFlat = canExplain
      ? {
          pages: tiedRows.map((r) => r.page),
          typicalMs: median(typicalsOf(tiedRows)) as number,
          restTypicalMs: median(typicalsOf(eligible.filter((r) => !tiedSet.has(r.page)))),
        }
      : null;
    return { heldLongest: null, heldFlat };
  }
  const typicalMedian = median(typicalsOf(eligible)) ?? 0;
  if (leaderMs < HELD_MIN_LIFT * typicalMedian) {
    const heldFlat = canExplain
      ? { pages: eligible.map((r) => r.page).sort((a, b) => a - b), typicalMs: typicalMedian, restTypicalMs: null }
      : null;
    return { heldLongest: null, heldFlat };
  }
  return {
    heldLongest: {
      page: held.page,
      typicalMs: leaderMs,
      readCount: held.readCount,
      tiedPages: tiedRows.map((r) => r.page),
      tied: tiedRows.map((r) => ({ page: r.page, typicalMs: r.typicalMs as number, readCount: r.readCount })),
    },
    heldFlat: null,
  };
}

/** Every (person, stayed page) dwell, sorted ascending, with the owning person's key. */
export type ReadPairs = { ms: number[]; keys: string[]; readersByKey: Map<string, number>; readers: number };

/** Build the sorted stayed-page dwell list once so per-person exclusions stay O(M). */
export function buildReadPairs(people: Person[]): ReadPairs {
  const pairs: Array<{ ms: number; key: string }> = [];
  const readersByKey = new Map<string, number>();
  for (const p of people) {
    let n = 0;
    for (const c of p.cells) {
      if (c.state !== "read") continue;
      pairs.push({ ms: c.ms, key: p.key });
      n += 1;
    }
    if (n > 0) readersByKey.set(p.key, n);
  }
  pairs.sort((a, b) => a.ms - b.ms);
  return { ms: pairs.map((x) => x.ms), keys: pairs.map((x) => x.key), readersByKey, readers: readersByKey.size };
}

/** Median stayed-page dwell over everyone except `excludeKey`, walking the pre-sorted pairs once. */
export function typicalFromPairs(pairs: ReadPairs, excludeKey: string | null): { ms: number | null; people: number } {
  const excludedCount = excludeKey ? (pairs.readersByKey.get(excludeKey) ?? 0) : 0;
  const people = pairs.readers - (excludedCount > 0 ? 1 : 0);
  const n = pairs.ms.length - excludedCount;
  if (n <= 0) return { ms: null, people };
  const hi = Math.floor(n / 2);
  const lo = n % 2 === 1 ? hi : hi - 1;
  let idx = 0;
  let loVal = 0;
  for (let i = 0; i < pairs.ms.length; i++) {
    if (excludedCount > 0 && pairs.keys[i] === excludeKey) continue;
    if (idx === lo) loVal = pairs.ms[i];
    if (idx === hi) return { ms: lo === hi ? pairs.ms[i] : Math.floor((loVal + pairs.ms[i]) / 2), people };
    idx += 1;
  }
  return { ms: null, people };
}

/** Median dwell over every stayed page of people other than `excludeKey`, and how many of them stayed anywhere. */
export function typicalPageMs(peopleWithDetail: Person[], excludeKey: string | null): { ms: number | null; people: number } {
  return typicalFromPairs(buildReadPairs(peopleWithDetail), excludeKey);
}

/** Why page highlights are hidden, or null when they show (or there is nothing to explain). */
export function calloutGateText(people: number, peopleWithDetail: number): string | null {
  if (peopleWithDetail === 0 || peopleWithDetail >= CALLOUT_MIN_PEOPLE) return null;
  if (people < CALLOUT_MIN_PEOPLE) return "Page highlights appear once 5 people have opened it.";
  return "Page highlights appear once 5 people have page detail.";
}
