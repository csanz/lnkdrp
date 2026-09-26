/**
 * The by-day chart moved out of the `/activity` header, and the header must not have changed.
 *
 * `WorkChart` was private to `src/app/(app)/activity/StatsHeader.tsx` until the contributor pages
 * wanted the same picture. An extraction like that has one failure mode worth a test: the copy in
 * the new file drifts a line width, a tick count or a colour away from the original and nobody
 * notices, because the activity page still renders something chart-shaped.
 *
 * There is no DOM in this suite (`environment: "node"`, no jsdom), so recharts cannot be rendered
 * here. What can be pinned is everything the move actually touched: `pickTicks`, the only logic
 * that came with it, and the header's own source, which must now delegate rather than declare -
 * with the same three props it always passed, under the same condition it always passed them.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { pickTicks, TOOLTIP_STYLE } from "@/components/activity/WorkChart";
import type { ActivityDayPoint } from "@/lib/activity/summary";

const ROOT = path.resolve(__dirname, "../..");
const HEADER = readFileSync(path.join(ROOT, "src/app/(app)/activity/StatsHeader.tsx"), "utf8");
const CHART = readFileSync(path.join(ROOT, "src/components/activity/WorkChart.tsx"), "utf8");

/** `n` consecutive day points; only `day` matters to the tick picker. */
function series(n: number): ActivityDayPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    day: `2026-09-${String(i + 1).padStart(2, "0")}`,
    total: 0,
    people: 0,
    agents: 0,
    docsAdded: 0,
    docsReplaced: 0,
    linksCreated: 0,
    docsRemoved: 0,
    projectsCreated: 0,
  }));
}

describe("pickTicks", () => {
  test("a short series keeps every day", () => {
    expect(pickTicks(series(4), 5)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]);
  });

  test("a 30-day window is reduced to five evenly spaced dates, ends included", () => {
    const ticks = pickTicks(series(30), 5);
    expect(ticks).toEqual(["2026-09-01", "2026-09-08", "2026-09-16", "2026-09-23", "2026-09-30"]);
  });

  test("the first and last day are always there, at any length", () => {
    for (const n of [5, 6, 14, 31, 90, 365]) {
      const ticks = pickTicks(series(n), 5);
      expect(ticks[0]).toBe(`2026-09-01`);
      expect(ticks[ticks.length - 1]).toBe(series(n)[n - 1]!.day);
      expect(ticks.length).toBeLessThanOrEqual(5);
    }
  });

  test("an empty series asks for no labels rather than throwing", () => {
    expect(pickTicks([], 5)).toEqual([]);
  });
});

describe("the activity header delegates instead of declaring", () => {
  test("it imports the shared chart", () => {
    expect(HEADER).toContain('import WorkChart, { TOOLTIP_STYLE } from "@/components/activity/WorkChart"');
  });

  test("it renders it with the same props, under the same condition, in the same place", () => {
    expect(HEADER).toContain(
      "{data.series.length ? <WorkChart series={data.series} counts={counts} days={data.days} /> : null}",
    );
  });

  test("the chart is declared in exactly one file", () => {
    expect(HEADER).not.toContain("function WorkChart");
    expect(HEADER).not.toContain("function pickTicks");
    expect(CHART).toContain("export default function WorkChart");
  });

  test("and the drawing pieces went with it rather than being left behind or duplicated", () => {
    for (const piece of ["BUCKET_COLORS", "LineChart", "CartesianGrid", "const TICK_COUNT = 5"]) {
      expect(CHART).toContain(piece);
      expect(HEADER).not.toContain(piece);
    }
    // The donut sits beside the chart in the header's card and still shares its tooltip surface,
    // which is why that one constant is exported rather than moved out of reach.
    expect(HEADER).toContain("contentStyle={TOOLTIP_STYLE}");
    expect(TOOLTIP_STYLE).toEqual({
      background: "var(--panel)",
      border: "1px solid var(--border)",
      borderRadius: 10,
      padding: "6px 8px",
      fontSize: 12,
      color: "var(--fg)",
    });
  });

  test("the header's window is still the fixed 30 days it was", () => {
    expect(HEADER).toContain("const DAYS = 30;");
  });
});
