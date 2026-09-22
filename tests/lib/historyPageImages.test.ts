/**
 * The owner's history page has to actually receive the two page renders.
 *
 * `DocChange.pagesThatChanged[]` has carried `previousImageUrl`, `newImageUrl` and `imageChanged`
 * since the field was added - its schema comment says "for visual diffs in history UIs" - and for
 * just as long the changes route mapped the array down to `{pageNumber, summary}` one line before
 * returning, while the history client had no field for them at all. The result was an owner page
 * that showed strictly less about a change than the recipient's viewer did, with the answer sitting
 * in Mongo the whole time.
 *
 * Both halves of that are easy to undo by accident, because each looks like tidying: the route's
 * map is one `.map` among several, and the client's parser builds its item object field by field.
 * These assert the fields survive the whole way across.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

const ROUTE = read("src/app/api/docs/[docId]/changes/route.ts");
const CLIENT = read("src/app/(app)/doc/[docId]/history/pageClient.tsx");
const STRIP = read("src/components/history/PageDiffStrip.tsx");
const MODEL = read("src/lib/models/DocChange.ts");

describe("the changes API returns the page renders", () => {
  test("the pagesThatChanged projection carries both image URLs and the verdict", () => {
    for (const field of ["previousImageUrl", "newImageUrl", "imageChanged"]) {
      expect(ROUTE, `${field} is stripped from the payload again`).toContain(`${field}:`);
    }
  });

  test("it also reports why a version has no summary", () => {
    // `Upload.ai` records this and the upload endpoint already returns it; the history page just
    // never asked, so "out of credits" and "nobody has run it" rendered identically.
    for (const field of ["compare:", "compareCode:", "compareReason:", "unchangedFromPrevious:"]) {
      expect(ROUTE).toContain(field);
    }
    // `ai` is Mixed and can hold raw error text, so it must be whitelisted rather than forwarded.
    expect(ROUTE).not.toMatch(/\bai: \(r\?\.ai \?\? null\) as [^;]*;\s*\n\s*uploadFactsByVersion\.set\(v, \{[^}]*ai,/);
  });

  test("the total changed-page count is selected and returned", () => {
    expect(ROUTE).toContain("changedPageCount: 1");
    expect(ROUTE).toMatch(/changedPageCount:\s*\n?\s*typeof c\?\.changedPageCount === "number"/);
  });
});

describe("the history client reads them", () => {
  test("the parser lifts pagesThatChanged off the payload", () => {
    expect(CLIENT).toContain("pagesThatChanged: Array.isArray(c?.pagesThatChanged)");
    for (const field of ["previousImageUrl", "newImageUrl", "imageChanged"]) {
      expect(CLIENT).toContain(field);
    }
  });

  test("the expanded row renders the strip", () => {
    expect(CLIENT).toContain("<PageDiffStrip");
    expect(CLIENT).toContain('from "@/components/history/PageDiffStrip"');
  });

  test("the row type and the component share one PageChange type", () => {
    // Two hand-written copies of this shape would drift, and the drift is silent: an extra field on
    // one side is simply never rendered.
    expect(CLIENT).toContain("type PageChange }");
    expect(STRIP).toContain("export type PageChange");
  });
});

describe("the count is stored, not recomputed", () => {
  test("DocChange has a top-level changedPageCount", () => {
    // Top level rather than inside `diff`: the count is deterministic and true even when no model
    // ran, and `diff` is empty whenever AI is off, credits ran out, or nothing changed.
    expect(MODEL).toMatch(/changedPageCount: \{ type: Number, min: 0, default: null \}/);
    const diffAt = MODEL.indexOf("diff: {");
    const countAt = MODEL.indexOf("changedPageCount:");
    expect(countAt, "changedPageCount moved inside diff").toBeLessThan(diffAt);
  });
});

describe("impact does not key on a substring of the summary", () => {
  test("it uses isNoChangeSummary rather than includes('no changes')", () => {
    // "No changes to the financials, but the logo was replaced" used to label the whole version
    // None, which is the opposite of what it says.
    expect(CLIENT).toContain("isNoChangeSummary(item.summary");
    expect(CLIENT).not.toContain('s.includes("no changes")');
  });
});
