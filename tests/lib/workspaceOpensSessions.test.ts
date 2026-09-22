/**
 * Workspace `opens`: one sitting, one open — in **both** windows.
 *
 * The headline chip compares the current window's opens against the previous period's, and the two
 * were built by different pipelines. The current one collapsed visit rows to sittings; the previous
 * one counted rows. A data-room sitting writes one `ShareVisit` row per document, so the baseline
 * was systematically larger than the same traffic in the current window, and the chip printed a
 * decline nobody's reading had fallen by.
 *
 * Both windows now go through `visitSessionStages`, so this runs the fragments that ship against a
 * fixture and asserts they answer the same question in the same unit. The stages are evaluated by a
 * deliberately small `$group` interpreter rather than a database: a wrong field reference in an
 * aggregation expression yields `null` instead of an error, which is the same reason
 * `tests/lib/workspaceMetrics.test.ts` pins these shapes at all.
 */
import { describe, expect, test } from "vitest";

import { previousVisitTotalsPipeline, visitSessionStages } from "@/lib/analytics/workspace/query";
import { VISIT_DAY_KEY_EXPR } from "@/lib/analytics/workspace/match";

type Row = Record<string, unknown>;
type GroupStage = { $group: Record<string, unknown> };

function fieldPath(doc: Row, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((acc, part) => (acc && typeof acc === "object" ? (acc as Row)[part] : undefined), doc);
}

/** The handful of expression forms these two stages use, and nothing else. */
function evalExpr(doc: Row, expr: unknown): unknown {
  if (typeof expr === "string" && expr.startsWith("$")) return fieldPath(doc, expr.slice(1));
  if (expr && typeof expr === "object") {
    const node = expr as Record<string, unknown>;
    if ("$ifNull" in node) {
      const [primary, fallback] = node.$ifNull as [unknown, unknown];
      const value = evalExpr(doc, primary);
      return value === null || value === undefined ? evalExpr(doc, fallback) : value;
    }
    if ("$dateToString" in node) {
      const spec = node.$dateToString as { date: unknown };
      const date = evalExpr(doc, spec.date) as Date;
      return date.toISOString().slice(0, 10);
    }
    throw new Error(`unsupported expression: ${JSON.stringify(expr)}`);
  }
  return expr;
}

function runGroup(rows: Row[], stage: GroupStage): Row[] {
  const { _id, ...accumulators } = stage.$group;
  const buckets = new Map<string, Row>();
  for (const row of rows) {
    const id =
      _id === null
        ? null
        : typeof _id === "string"
          ? evalExpr(row, _id)
          : Object.fromEntries(
              Object.entries(_id as Record<string, unknown>).map(([key, expr]) => [key, evalExpr(row, expr)]),
            );
    const key = JSON.stringify(id);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { _id: id };
      for (const name of Object.keys(accumulators)) bucket[name] = 0;
      buckets.set(key, bucket);
    }
    for (const [name, accumulator] of Object.entries(accumulators)) {
      const operand = (accumulator as { $sum?: unknown }).$sum;
      const value = operand === 1 ? 1 : Number(evalExpr(row, operand) ?? 0);
      bucket[name] = Number(bucket[name]) + value;
    }
  }
  return [...buckets.values()];
}

function runStages(rows: Row[], stages: unknown[]): Row[] {
  return stages.reduce<Row[]>((acc, stage) => runGroup(acc, stage as GroupStage), rows);
}

/**
 * One afternoon in a data room (`room-link`, one tab, three documents) plus one sitting on an
 * ordinary document link. Three sittings' worth of rows, two sittings.
 */
const ROWS: Row[] = [
  { shareId: "room-link", visitIdHash: "v1", docId: "deck", timeSpentMs: 4_000, lastEventAt: new Date("2026-08-02T10:00:00.000Z") },
  { shareId: "room-link", visitIdHash: "v1", docId: "model", timeSpentMs: 6_000, lastEventAt: new Date("2026-08-02T10:30:00.000Z") },
  { shareId: "room-link", visitIdHash: "v1", docId: "cap-table", lastEventAt: new Date("2026-08-02T10:40:00.000Z") },
  { shareId: "deck-link", visitIdHash: "v2", docId: "deck", timeSpentMs: 5_000, lastEventAt: new Date("2026-08-03T09:00:00.000Z") },
];

describe("visitSessionStages", () => {
  test("a data-room sitting that opened three documents is one open, not three", () => {
    const [total] = runStages(ROWS, visitSessionStages());
    expect(total.opens).toBe(2);
    // Time is summed across the sitting's rows: each one holds the time spent in its own document.
    expect(total.readingTimeMs).toBe(15_000);
    expect(total._id).toBeNull();
  });

  test("bucketed by day, the same rows still count sittings", () => {
    const byDay = runStages(ROWS, visitSessionStages({ as: "day", expr: VISIT_DAY_KEY_EXPR }));
    expect(byDay.map((r) => [r._id, r.opens])).toEqual([
      ["2026-08-02", 1],
      ["2026-08-03", 1],
    ]);
    // The series has to sum to the tile, so the two shapes cannot disagree on the total.
    expect(byDay.reduce((acc, r) => acc + Number(r.opens), 0)).toBe(2);
  });
});

describe("previousVisitTotalsPipeline", () => {
  const match = { orgId: { $in: ["org", null] }, lastEventAt: { $gte: new Date("2026-07-20"), $lt: new Date("2026-08-19") } };

  test("scopes on the caller's match, then collapses sittings exactly as the current window does", () => {
    const pipeline = previousVisitTotalsPipeline(match);
    expect(pipeline[0]).toEqual({ $match: match });
    expect(pipeline.slice(1)).toEqual(visitSessionStages());
  });

  test("the baseline counts sittings, so the comparison is in the same unit as the value", () => {
    const [previous] = runStages(ROWS, previousVisitTotalsPipeline(match).slice(1));
    // 4 rows, 2 sittings. Counting rows here reported 4 against a current-window 2 and turned a
    // flat month into a 50% drop.
    expect(previous.opens).toBe(2);
    expect(previous.readingTimeMs).toBe(15_000);
  });
});
