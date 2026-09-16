import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Free cap counts shared documents; share links are never capped. That fact has drifted into
 * copy that says "links" three times now (planLimits.ts explains the first; the upload page's
 * "All 3 Free links are in use" was the third). Greps by exact phrase kept missing the next
 * wording, so this walks every user-facing source file for the *concept*: any sentence that
 * describes a link cap. A hit here is a bug in copy, not in this test — reword to "documents".
 *
 * Comment lines are skipped: they are allowed to quote the old wording when explaining the fix.
 */
const SRC = path.resolve(__dirname, "../../src");

const LINK_CAP_PHRASES: RegExp[] = [
  /\bFree links?\b/i, // "All 3 Free links are in use"
  /\blinks? (are|is) in use\b/i,
  /\blink limit\b/i, // "At your link limit"
  /\blinks? left\b/i,
  /\bmore links?\b.*\b(upgrade|Pro)\b/i,
  /\bActive share links:/, // the plan-limit email's over-limit line
  /\bFree includes \$\{plural\([A-Z_]+, "link"/, // same line, before the wording
  /\bdisable a share link\b/i, // as the remedy for being over the cap
  /\bNew links are paused\b/i,
  /\bnew share links (and projects )?(are|will be) paused\b/i,
  /\bof \$?\{?[a-zA-Z.?]*max\}? links\b/, // "{used} of {max} links"
  /\blinks? (you can|to) (share|send)\b.*\bFree\b/i,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|mdx?)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);

describe("plan-cap copy speaks of documents, never a link cap", () => {
  it("no user-facing source describes a cap on links", () => {
    const hits: string[] = [];
    for (const file of walk(SRC)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (isComment(line)) return;
        for (const re of LINK_CAP_PHRASES) {
          if (re.test(line)) {
            hits.push(`${path.relative(SRC, file)}:${i + 1}  ${line.trim().slice(0, 120)}`);
            break;
          }
        }
      });
    }
    expect(hits, `copy still describes a link cap:\n${hits.join("\n")}`).toEqual([]);
  });
});
