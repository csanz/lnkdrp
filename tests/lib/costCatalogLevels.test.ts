import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  COST_CATALOG,
  FREE_ACTIONS,
  QUALITY_TIERS,
  costEntryForAction,
  flatPriceOf,
  hasQualityLevels,
} from "@/lib/credits/costCatalog";
import { creditsForRun } from "@/lib/credits/schedule";
import type { QualityTier } from "@/lib/credits/types";

/**
 * The catalog is an advertisement, and `/costs` and `/pricing` print it verbatim. So every level it
 * shows has to be a level a customer can actually order and be charged for.
 *
 * The summary row failed that: it quoted 1/2/5 by level and told people to ask for a better one
 * from the document page, while every path that can run a summary pins it to Basic. These tests
 * read the production code for the answer rather than restating the catalog, so the day someone
 * adds a real level chooser the catalog is told to catch up.
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const PROCESS_ROUTE = "src/app/api/uploads/[uploadId]/process/route.ts";
const SUMMARY_ROUTE = "src/app/api/uploads/[uploadId]/summary/route.ts";
const COMPARE_RERUN_ROUTE = "src/app/api/docs/[docId]/changes/[changeId]/rerun/route.ts";
const HISTORY_CLIENT = "src/app/(app)/doc/[docId]/history/pageClient.tsx";
const DOC_CLIENT = "src/app/(app)/doc/[docId]/pageClient.tsx";
const REVIEW_PAGE = "src/app/(app)/doc/[docId]/review/page.tsx";

/** Files that hold a charge for an action, so the scan below looks in one place for each. */
const CHARGE_SOURCES = [PROCESS_ROUTE, SUMMARY_ROUTE, COMPARE_RERUN_ROUTE] as const;

const TIERS = new Set<string>(QUALITY_TIERS);

/**
 * Every quality tier the source can charge the given action at.
 *
 * Finds each `actionType: "<action>",` in an object literal and reads the `qualityTier:` beside it,
 * resolving a local `const x = "standard"` binding to its value. A tier that arrives from the
 * request rather than from a literal is reported as `"*"`: a caller-chosen level.
 */
function chargeableTiers(source: string, action: string): Set<string> {
  const found = new Set<string>();
  const re = new RegExp(`actionType:\\s*"${action}"\\s*,`, "g");
  for (const match of source.matchAll(re)) {
    const window = source.slice(match.index ?? 0, (match.index ?? 0) + 400);
    // `qualityTier: "basic"`, `qualityTier: someConst`, or the shorthand `qualityTier,`.
    const tier = /qualityTier\s*(?::\s*("?)([A-Za-z_][\w]*)\1)?\s*[,}]/.exec(window);
    if (!tier) continue;
    const token = tier[2] ?? "qualityTier";
    if (TIERS.has(token)) {
      found.add(token);
      continue;
    }
    // An identifier: resolve it against a literal binding in the same file, else call it caller-chosen.
    const bound = new RegExp(`(?:const|let)\\s+${token}\\s*(?::[^=]+)?=\\s*"(basic|standard|advanced)"`).exec(source);
    found.add(bound ? (bound[1] as string) : "*");
  }
  return found;
}

/** Union of the tiers every charge source can charge an action at. */
function chargeableTiersAcrossApp(action: string): Set<string> {
  const all = new Set<string>();
  for (const file of CHARGE_SOURCES) for (const t of chargeableTiers(read(file), action)) all.add(t);
  return all;
}

describe("the catalog advertises only levels the code can charge", () => {
  test("the summary is Basic everywhere, so it is advertised at one price with no level", () => {
    // The truth, read from the code: both the automatic run and the manual rerun pin Basic.
    expect(chargeableTiersAcrossApp("summary")).toEqual(new Set(["basic"]));
    expect(read(PROCESS_ROUTE)).toContain('const summaryTier = "basic" as const;');

    const entry = costEntryForAction("summary");
    expect(entry).not.toBeNull();
    expect(hasQualityLevels(entry!)).toBe(false);
    expect(entry!.levels).toEqual([]);
    expect(flatPriceOf(entry!)).toBe(creditsForRun({ actionType: "summary", qualityTier: "basic" }));
    // The old row advertised 1/2/5; a flat row must not print three different numbers.
    expect(new Set(QUALITY_TIERS.map((t) => entry!.costs[t])).size).toBe(1);
  });

  test("nothing offers a level for a summary: not the rerun route, not the document page", () => {
    const route = read(SUMMARY_ROUTE);
    // The route takes no body and reads no tier; the only tier it names is the one it prices at.
    expect(route).toContain('qualityTier: "basic"');
    expect(route).not.toMatch(/"standard"|"advanced"/);
    expect(route).not.toMatch(/request\.json\(\)/);
    // The document page's "write the summary again" button posts nothing at all.
    expect(read(DOC_CLIENT)).toContain('/summary`, { method: "POST" }');
  });

  test("no catalog note tells a reader to ask for a better summary", () => {
    const notes = (costEntryForAction("summary")?.notes ?? []).join(" ").toLowerCase();
    expect(notes).not.toMatch(/ask for a better one/);
    expect(notes).toContain("no quality level to choose");
  });

  test("AI compare really is chosen per level, so it keeps all three", () => {
    // A caller-chosen tier ("*") is exactly what a level chooser looks like from here.
    expect(chargeableTiers(read(COMPARE_RERUN_ROUTE), "history").has("*")).toBe(true);
    expect(read(HISTORY_CLIENT)).toContain('body: JSON.stringify({ qualityTier: tier })');

    const entry = costEntryForAction("history");
    expect(entry).not.toBeNull();
    expect(entry!.levels).toEqual(QUALITY_TIERS);
    for (const tier of QUALITY_TIERS) {
      expect(entry!.costs[tier]).toBe(creditsForRun({ actionType: "history", qualityTier: tier }));
    }
  });

  test("the visit brief keeps its single price", () => {
    const entry = costEntryForAction("brief");
    expect(entry).not.toBeNull();
    expect(hasQualityLevels(entry!)).toBe(false);
    expect(flatPriceOf(entry!)).toBe(creditsForRun({ actionType: "brief", qualityTier: "basic" }));
  });

  test("AI review is not released, and the row no longer quotes the live bill for it", () => {
    // The only way to reach a review is through pages behind NEXT_PUBLIC_FEATURE_REQUESTS, which is
    // unset at launch. "Not available yet" is the true statement, so the row says so.
    expect(read(REVIEW_PAGE)).toContain('process.env.NEXT_PUBLIC_FEATURE_REQUESTS === "1"');
    expect(read(REVIEW_PAGE)).toContain("notFound()");

    const entry = costEntryForAction("review");
    expect(entry).not.toBeNull();
    expect(entry!.released).toBe(false);
    expect((entry!.notes ?? []).join(" ").toLowerCase()).toContain("not available yet");
  });

  test("every flat row is flat in all three numbers, and every levelled row prices each level", () => {
    for (const entry of COST_CATALOG) {
      const values = QUALITY_TIERS.map((t) => entry.costs[t]);
      if (!hasQualityLevels(entry)) {
        expect(new Set(values).size, `${entry.label} advertises no level but several prices`).toBe(1);
      } else {
        expect(entry.levels, `${entry.label} advertises a partial level list`).toEqual(QUALITY_TIERS);
      }
      for (const v of values) expect(Number.isInteger(v) && v >= 0).toBe(true);
    }
  });

  test("released rows still take their prices from the charging schedule", () => {
    for (const entry of COST_CATALOG) {
      if (!entry.released || !entry.action) continue;
      const tiers: QualityTier[] = hasQualityLevels(entry) ? [...QUALITY_TIERS] : ["basic"];
      for (const tier of tiers) {
        expect(entry.costs[tier]).toBe(creditsForRun({ actionType: entry.action, qualityTier: tier }));
      }
    }
  });
});

describe("deliberate free behaviour stays advertised and stays free", () => {
  test("a summary still costs one credit at Basic: this change moved no price", () => {
    expect(creditsForRun({ actionType: "summary", qualityTier: "basic" })).toBe(1);
    expect(creditsForRun({ actionType: "brief", qualityTier: "basic" })).toBe(1);
  });

  test("agent-written summaries and recipient uploads are still listed as free", () => {
    const free = FREE_ACTIONS.join(" ").toLowerCase();
    expect(free).toContain("summaries your agent writes over mcp");
    expect(free).toContain("files recipients upload");
  });

  test("an unchanged replacement still skips the summary, so it costs nothing", () => {
    const route = read(PROCESS_ROUTE);
    expect(route).toContain("const sameAsPreviousVersion =");
    expect(route).toMatch(/summaryWanted\s*=\s*[\s\S]{0,200}!sameAsPreviousVersion/);
  });
});

/**
 * `/help/credits-and-plans` is the third customer-facing surface for the same prices, and it is a
 * statically generated public page (`src/app/help/[slug]/page.tsx` renders `src/content/help/*.md`
 * through `src/lib/help/articles.ts`), so Plain's support agent answers from it too.
 *
 * What went wrong: the catalog was corrected while the article still printed the summary at
 * 1/2/5 by level and still told readers to "ask for a better one from the document page", which
 * left three surfaces disagreeing about a price and pointed support at a control that does not
 * exist. These tests hold the article to the catalog.
 */
describe("the help article agrees with the catalog", () => {
  const ARTICLE = "src/content/help/credits-and-plans.md";
  const body = () => read(ARTICLE);

  test("the summary is printed once, not as three prices under three level headings", () => {
    const summary = costEntryForAction("summary")!;
    const rows = body()
      .split(/\r?\n/)
      .filter((line) => line.trim().startsWith("|") && /summary/i.test(line));
    expect(rows.length, "the article should price the summary on exactly one table row").toBe(1);
    // Cells of that row, minus the leading label: a flat row carries a single price.
    const cells = rows[0].split("|").map((c) => c.trim()).filter(Boolean).slice(1);
    expect(cells).toEqual([String(flatPriceOf(summary))]);
    expect(body()).not.toContain("| Summary and key points | 1 | 2 | 5 |");
  });

  test("it no longer sends readers hunting for a summary level", () => {
    const text = body().toLowerCase();
    expect(text).not.toMatch(/ask for a better one/);
    expect(text).not.toMatch(/summary runs automatically at basic/);
    expect(text).toMatch(/no level to choose/);
  });

  test("rewriting a skipped or failed summary is quoted at the same one credit", () => {
    const summary = costEntryForAction("summary")!;
    expect(body()).toContain(`the same ${flatPriceOf(summary)} credit`);
  });

  test("every price in the article's tables matches the catalog", () => {
    const text = body();
    for (const entry of COST_CATALOG) {
      if (!entry.released || !entry.action) continue;
      const row = text.split(/\r?\n/).find((line) => line.trim().startsWith("|") && line.includes(entry.label));
      if (!row) continue;
      const cells = row.split("|").map((c) => c.trim()).filter(Boolean).slice(1);
      const expected = hasQualityLevels(entry)
        ? QUALITY_TIERS.map((t) => String(entry.costs[t]))
        : [String(flatPriceOf(entry))];
      expect(cells, `${entry.label} is priced differently in the help article`).toEqual(expected);
    }
  });
});
