/**
 * No em dashes in anything a person can read on the site.
 *
 * A house rule (2026-09-23): copy uses commas, colons, periods and parentheses, never "—". The
 * rule covers strings, template literals and JSX text under `src/`, which is everything that can
 * reach a page, an email or an API message. Comments are free to use whatever they like: they are
 * not on the website, and this codebase's comments use the em dash constantly.
 *
 * En dashes are allowed. "10–12" is a page range, "–" on its own is the empty-value placeholder in
 * a table, and neither is an em dash.
 *
 * `scripts/` and `mcp/` are out of scope: terminal output and tool descriptions are not the website.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const SRC = path.join(ROOT, "src");

/**
 * Strings that must contain an em dash because they match one in text somebody else wrote.
 * Keyed by file (forward slashes, relative to the repo root) and a substring of the string.
 */
const ALLOWED: Array<{ file: string; contains: string }> = [
  // Regex source that recognises the separator an AI brief may have used before the fix.
  { file: "src/lib/notifications/visitBriefEmail.ts", contains: "[^:—-]" },
  { file: "src/lib/notifications/visitBriefEmail.ts", contains: "[:—-]" },
];

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(p);
    else if (/\.(tsx?|mjs|js)$/.test(entry.name)) yield p;
  }
}

type Hit = { file: string; line: number; text: string };

/** Every em dash inside a string literal, template literal chunk or JSX text node. */
function emDashStrings(file: string): Hit[] {
  const src = fs.readFileSync(file, "utf8");
  if (!src.includes("—")) return [];
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  const kind = file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  const hits: Hit[] = [];
  const visit = (node: ts.Node) => {
    let text: string | null = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) text = node.text;
    else if (ts.isJsxText(node)) text = node.text;
    if (text && text.includes("—")) {
      const allowed = ALLOWED.some((a) => a.file === rel && text!.includes(a.contains));
      if (!allowed) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        hits.push({ file: rel, line: line + 1, text: text.replace(/\s+/g, " ").trim().slice(0, 100) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe("site copy", () => {
  test("no string, template or JSX text under src/ contains an em dash", () => {
    const hits: Hit[] = [];
    for (const file of sourceFiles(SRC)) hits.push(...emDashStrings(file));
    const report = hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join("\n");
    expect(hits, `em dashes in user-facing text (use a comma, colon, period or parentheses):\n${report}`).toEqual([]);
  });

  test("the help articles are clean too", () => {
    const dir = path.join(SRC, "content");
    if (!fs.existsSync(dir)) return;
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.(mdx?|txt|json)$/.test(entry.name) && fs.readFileSync(p, "utf8").includes("—")) {
          offenders.push(path.relative(ROOT, p).split(path.sep).join("/"));
        }
      }
    };
    walk(dir);
    expect(offenders).toEqual([]);
  });
});
