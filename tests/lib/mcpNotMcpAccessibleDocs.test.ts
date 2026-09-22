/**
 * A doc that sends a reader to `whoami.capabilities.notMcpAccessible` has to say what is in it.
 *
 * `docs/reviews/mcp-test-coverage-2026-09-21.md` listed the six product surfaces with no MCP tool
 * (version history, workspace metrics, project analytics, project-link passwords, member and
 * invite management, billing detail) and then said they were "Reported in
 * `whoami.capabilities.notMcpAccessible`". They never were. The field has held exactly
 * `requestRepos` and `downloadAccessRequests` since it shipped, on every commit including the one
 * that doc was committed against, and the sentence was not in the changelog the section says it
 * carries. A reader who called `whoami` to find the warning about, say, workspace metrics got two
 * unrelated entries back and had to decide whether the field was broken or the doc was.
 *
 * The field's membership is deliberate and it does move: `projectManagement` sat there until the
 * project tools shipped. So the guard is not a frozen list. It reads the members out of
 * `mcp/src/tools/whoami.ts` and requires every prose block that tells a reader what the field
 * reports to name all of them. That fails both ways a reader gets misled: a doc claiming contents
 * the field does not have, and a feature added to the field that no doc mentions.
 *
 * Only blocks that *attribute contents* are checked. A table row saying where
 * `NEXT_PUBLIC_FEATURE_REQUESTS` is surfaced, or a line listing the `capabilities` shape, mentions
 * the field without claiming what is in it, and demanding the roster there would be noise.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const WHOAMI_SRC = readFileSync(path.join(ROOT, "mcp/src/tools/whoami.ts"), "utf8");

/** The field name, spelled once so a rename does not leave this file silently passing. */
const FIELD = "notMcpAccessible";

/**
 * Verbs that turn a mention into a claim about membership. "Reported in", the phrasing that was
 * wrong, is here; "surfaced in" is not, because that says where a flag shows up rather than what
 * the roster is.
 */
const ATTRIBUTION = /\b(reported in|names?|naming|lists?|listing|holds?|carries|contains)\b/i;

/** The `feature:` strings of the `notMcpAccessible` array literal, in source order. */
function membersFromSource(): string[] {
  const start = WHOAMI_SRC.indexOf(`const ${FIELD}: UncoveredFeature[] = [`);
  expect(start, `mcp/src/tools/whoami.ts no longer builds ${FIELD} as a typed array literal`).toBeGreaterThan(-1);
  const end = WHOAMI_SRC.indexOf("\n  ];", start);
  expect(end, `${FIELD} array literal is unterminated`).toBeGreaterThan(start);
  const literal = WHOAMI_SRC.slice(start, end);
  return [...literal.matchAll(/feature:\s*"([A-Za-z]+)"/g)].map((m) => m[1]);
}

/** Every markdown file under `docs/`, plus the MCP server's own README. */
function markdownFiles(): string[] {
  const found = [path.join(ROOT, "mcp/README.md")];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".md")) found.push(full);
    }
  };
  walk(path.join(ROOT, "docs"));
  return found;
}

/**
 * Split markdown into the units a reader takes in at once: a bullet or numbered item runs to the
 * next one or to a blank line, and everything else splits on blank lines. Table rows are dropped:
 * a row is a note on the row's subject, not a statement about this field's roster. Bullet-level
 * granularity matters because the section that was wrong is one bullet in a list with no blank
 * lines in it, and a neighbouring bullet naming the members must not excuse it.
 */
function blocks(text: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) out.push(current.join("\n"));
    current = [];
  };
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("|")) flush();
    else if (/^\s*([-*]\s|\d+\.\s)/.test(line)) {
      flush();
      current.push(line);
    } else current.push(line);
  }
  flush();
  return out;
}

/** Blocks anywhere in the docs that tell a reader what the field reports. */
function attributionBlocks(): { file: string; block: string }[] {
  const found: { file: string; block: string }[] = [];
  for (const file of markdownFiles()) {
    for (const block of blocks(readFileSync(file, "utf8"))) {
      if (block.includes(FIELD) && ATTRIBUTION.test(block)) {
        found.push({ file: path.relative(ROOT, file), block });
      }
    }
  }
  return found;
}

describe(`docs describing whoami.capabilities.${FIELD}`, () => {
  const members = membersFromSource();
  const attributions = attributionBlocks();

  it("reads the members out of the tool source", () => {
    // If the parse silently returns nothing, every test below passes on an empty roster.
    expect(members.length).toBeGreaterThan(0);
  });

  it("finds the blocks that claim what the field reports", () => {
    // Same trap one level up: a broken block splitter would find no blocks and assert nothing.
    expect(attributions.length).toBeGreaterThan(0);
  });

  for (const { file, block } of attributions) {
    const excerpt = block.replace(/\s+/g, " ").slice(0, 120);
    it(`names every member where ${file} says what the field reports: "${excerpt}"`, () => {
      const missing = members.filter((m) => !block.includes(m));
      expect(missing, `${file} tells a reader what ${FIELD} reports without naming ${missing.join(", ")}`).toEqual([]);
    });
  }

  it("no longer says the six uncovered surfaces are reported in the field", () => {
    // The exact sentence, so a reworded claim cannot slip back in under the block check above by
    // naming the members and still asserting the six are among them.
    const review = readFileSync(path.join(ROOT, "docs/reviews/mcp-test-coverage-2026-09-21.md"), "utf8");
    const bullet = blocks(review).find((b) => b.includes("no MCP tool at all"));
    expect(bullet, "the review no longer has a bullet about surfaces with no MCP tool").toBeTruthy();
    expect(bullet!.replace(/\s+/g, " ")).not.toContain(`Reported in \`whoami.capabilities.${FIELD}\``);
  });
});
