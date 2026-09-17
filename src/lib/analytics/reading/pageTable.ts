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

/** Per-page reach, stayed count, typical time, passed and left-here over people with page detail. */
export function computePageTable(peopleWithDetail: Person[], P: number, meta: PageMeta[]): PageRow[] {
  const metaByPage = new Map(meta.map((m) => [m.page, m]));
  const rows: PageRow[] = [];
  for (let page = 1; page <= P; page++) {
    let reached = 0;
    let passed = 0;
    let leftHere = 0;
    let stillReading = 0;
    const readDwell: number[] = [];
    for (const person of peopleWithDetail) {
      const cell = person.cells[page - 1];
      if (cell && cell.state !== "unreached") reached += 1;
      if (cell?.state === "read") readDwell.push(cell.ms);
      if (cell?.state === "passed") passed += 1;
      if (person.exitPage === page) leftHere += 1;
      if (person.maxPage >= page) stillReading += 1;
    }
    const m = metaByPage.get(page);
    rows.push({
      page,
      label: m?.label ?? null,
      thumbUrl: m?.thumbUrl ?? null,
      reached,
      readCount: readDwell.length,
      typicalMs: readDwell.length >= TYPICAL_MIN_READERS ? median(readDwell) : null,
      passed,
      leftHere,
      stillReading,
    });
  }
  return rows;
}

/** Highlights for the page table; null below CALLOUT_MIN_PEOPLE people with page detail. */
export function computeCallouts(rows: PageRow[], peopleWithDetail: number, P: number): Callouts | null {
  if (peopleWithDetail < CALLOUT_MIN_PEOPLE) return null;

  let held: PageRow | null = null;
  for (const r of rows) {
    if (r.typicalMs === null) continue;
    if (
      !held ||
      r.typicalMs > (held.typicalMs as number) ||
      (r.typicalMs === held.typicalMs && (r.readCount > held.readCount || (r.readCount === held.readCount && r.page < held.page)))
    ) {
      held = r;
    }
  }

  let passed: PageRow | null = null;
  for (const r of rows) {
    if (r.passed < CALLOUT_MIN_COUNT) continue;
    if (
      !passed ||
      r.passed > passed.passed ||
      (r.passed === passed.passed && (r.reached > passed.reached || (r.reached === passed.reached && r.page < passed.page)))
    ) {
      passed = r;
    }
  }

  let left: PageRow | null = null;
  if (P > 1) {
    for (const r of rows) {
      if (r.page < 1 || r.page > P - 1 || r.leftHere < CALLOUT_MIN_COUNT) continue;
      if (!left || r.leftHere > left.leftHere || (r.leftHere === left.leftHere && r.page < left.page)) left = r;
    }
  }

  return {
    heldLongest: held ? { page: held.page, typicalMs: held.typicalMs as number, readCount: held.readCount } : null,
    mostPassed: passed ? { page: passed.page, passed: passed.passed, reached: passed.reached } : null,
    mostLeft: left ? { page: left.page, leftHere: left.leftHere, people: peopleWithDetail } : null,
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
