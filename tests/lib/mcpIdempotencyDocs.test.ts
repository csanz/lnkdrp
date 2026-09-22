/**
 * The Idempotency section of docs/MCP.md has to describe the idempotency wrappers that exist.
 *
 * It stopped doing that once already. The prose said `replace_pdf` neither marked a replay nor
 * checked its subject still existed, "because their result is the document's state either way",
 * and it kept saying so for as long as anyone read it: the paragraph was written forty minutes
 * before `replace_pdf` gained both (d82baed, then 305baf9). That paragraph is the reference a
 * maintainer opens before touching the wrappers, so the drift cost is a maintainer who concludes
 * the opposite of what the code does, and a reviewer who reads the doc rather than the tool.
 *
 * So the doc now carries a table instead of a sentence, and these tests read the table and the
 * tool sources and fail when the two disagree. The facts checked are the ones that drifted: which
 * tools mark a replay with `replayed: true`, and which check their subject still exists first.
 * They are read out of the sources by text on purpose, so a tool that gains a flag fails here
 * without anyone having to remember this file.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const DOC = readFileSync(path.join(ROOT, "docs/MCP.md"), "utf8");
const TOOLS_DIR = path.join(ROOT, "mcp/src/tools");

/** What a tool's source says it does on a replay. */
type ReplayBehaviour = { marksReplay: boolean; checksSubject: boolean };

/**
 * Read every `ctx.idempotency.run(IdempotencyStore.key(orgId, "<tool>", ...))` out of the tool
 * sources and look at the lines that follow it: the `stillExists` option sits in the same call's
 * options object, and the `replayed: true` the tool puts on its result is in the branch just after.
 * A 40-line window covers both in all four tools and stops well short of the next registration.
 */
function replayBehaviourFromSource(): Map<string, ReplayBehaviour> {
  const found = new Map<string, ReplayBehaviour>();
  for (const file of readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".ts"))) {
    const lines = readFileSync(path.join(TOOLS_DIR, file), "utf8").split("\n");
    lines.forEach((line, i) => {
      const match = /IdempotencyStore\.key\(\s*orgId,\s*"([a-z_]+)"/.exec(line);
      if (!match) return;
      const window = lines.slice(i, i + 40).join("\n");
      found.set(match[1], {
        marksReplay: /replayed:\s*true/.test(window),
        checksSubject: /stillExists:/.test(window),
      });
    });
  }
  return found;
}

/** The rows of the replay table in the doc's Idempotency section, keyed by tool name. */
function replayTableFromDoc(): Map<string, { flagged: string; subject: string }> {
  const section = DOC.split("\n## Idempotency\n")[1];
  expect(section, "docs/MCP.md has no '## Idempotency' section").toBeTruthy();
  const rows = new Map<string, { flagged: string; subject: string }>();
  for (const line of section.split("\n## ")[0].split("\n")) {
    const match = /^\|\s*`lnkdrp_([a-z_]+)`\s*\|([^|]*)\|([^|]*)\|/.exec(line);
    if (match) rows.set(match[1], { flagged: match[2].trim(), subject: match[3].trim() });
  }
  return rows;
}

/** A tool's own section of the reference, heading to next heading. */
function docSection(tool: string): string {
  const heading = new RegExp(`^#{3,4} \`lnkdrp_${tool}\``, "m");
  const start = DOC.search(heading);
  expect(start, `docs/MCP.md has no section for lnkdrp_${tool}`).toBeGreaterThan(-1);
  // Past the heading's own newline, or the next-heading search matches the heading we just found.
  const rest = DOC.slice(DOC.indexOf("\n", start) + 1);
  const end = rest.search(/^#{2,4} /m);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("docs/MCP.md idempotency table", () => {
  const source = replayBehaviourFromSource();
  const table = replayTableFromDoc();

  it("has a row for every tool that takes an idempotencyKey, and no others", () => {
    // A fifth idempotent tool is a fifth row. Without this the table stays true and incomplete,
    // which reads as "those are the idempotent tools" to anyone who trusts it.
    expect([...table.keys()].sort()).toEqual([...source.keys()].sort());
  });

  for (const [tool, behaviour] of source) {
    it(`says whether ${tool} marks a replay, and agrees with the code`, () => {
      const row = table.get(tool);
      expect(row, `no table row for ${tool}`).toBeTruthy();
      const saysFlagged = row!.flagged.includes("replayed: true");
      expect(saysFlagged, `table says ${tool} ${saysFlagged ? "does" : "does not"} flag a replay`).toBe(
        behaviour.marksReplay,
      );
    });

    it(`says whether ${tool} checks its subject still exists, and agrees with the code`, () => {
      const row = table.get(tool)!;
      const saysChecked = /^yes\b/.test(row.subject);
      expect(saysChecked, `table says ${tool} ${saysChecked ? "does" : "does not"} check its subject`).toBe(
        behaviour.checksSubject,
      );
    });

    it(`documents ${tool}'s result shape consistently with the flag`, () => {
      // The Out: line is what an agent author copies. `replace_pdf`'s omitted `replayed?` while the
      // prose underneath explained there was no such flag, and both were wrong together.
      const section = docSection(tool);
      expect(section.includes("replayed?"), `lnkdrp_${tool}'s Out shape`).toBe(behaviour.marksReplay);
    });
  }

  it("does not still carry the sentence that was false", () => {
    expect(DOC).not.toContain("There is no `replayed` flag on this tool");
    expect(DOC).not.toContain("`replace_pdf` and `set_share_access` do not");
  });
});
