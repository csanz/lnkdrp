import { READ_MIN_MS, VERDICT_LONGEST_MIN_MS, VERDICT_READ_MEDIAN_MS } from "./constants";
import { largestReturnGap } from "./attention";
import { formatDwell, formatGap } from "./format";
import { median } from "./pageTable";
import type { Person, Verdict } from "./types";

export type { Verdict } from "./types";

/**
 * One-line summary of how far a person got (coverage) and the most telling thing they did
 * (behaviour). "Read" appears only when every page was stayed on and the median stop is 10s or more.
 */
export function buildVerdict(p: Person, P: number, labels?: (page: number) => string | null): Verdict {
  if (!p.hasDetail) return { coverage: null, behaviour: null, text: "No page detail was recorded for this person." };

  const stopMs = p.visits.flatMap((v) => v.stops.map((s) => s.ms));
  const medianStopMs = median(stopMs) ?? 0;
  const allRead = p.cells.length > 0 && p.cells.every((c) => c.state === "read");
  const readAll = allRead && medianStopMs >= VERDICT_READ_MEDIAN_MS;

  let coverage: string;
  if (P === 1) coverage = readAll ? "Read the only page" : "Went through the only page";
  else if (p.reachedCount === P) coverage = readAll ? `Read all ${P} pages` : `Went through all ${P} pages`;
  else if (p.maxPage === 1) coverage = "Left on page 1";
  else if (p.maxPage === P) coverage = `Reached the last page, skipping ${P - p.reachedCount} of ${P} pages`;
  else coverage = `Stopped at page ${p.maxPage} of ${P}`;

  const behaviour = behaviourFor(p, labels);
  return { coverage, behaviour, text: behaviour ? `${coverage}. ${behaviour}.` : `${coverage}.` };
}

function behaviourFor(p: Person, labels?: (page: number) => string | null): string | null {
  const L = (k: number) => {
    const label = labels?.(k) ?? null;
    return label ? ` · ${label}` : "";
  };

  const gap = largestReturnGap(p);
  if (gap !== null) return `Came back ${formatGap(gap)} later`;

  const positive = p.dwellByPage.filter((ms) => ms > 0);
  if (positive.length >= 2) {
    let k = 1;
    p.dwellByPage.forEach((ms, i) => {
      if (ms > p.dwellByPage[k - 1]) k = i + 1;
    });
    const dwellK = p.dwellByPage[k - 1];
    const personMedian = median(positive) ?? 0;
    if (dwellK >= 2 * personMedian && dwellK >= VERDICT_LONGEST_MIN_MS) {
      return `Spent longest on page ${k}${L(k)} (${formatDwell(dwellK)})`;
    }
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
  if (back > 0) return `Went back to page ${back}${L(back)}`;

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
    return bestA === bestB ? `Passed over page ${bestA} quickly` : `Passed over pages ${bestA}–${bestB} quickly`;
  }
  return null;
}
