/**
 * The code map is generated, so it cannot quietly go stale again.
 *
 * `INDEX.md` was maintained by hand under a rule in `.cursorrules` that said to update it "in the
 * same change (no exceptions)". It was last touched on 2026-03-05 and then not again: by
 * 2026-09-23 it listed 413 paths against 762 files in `src/` alone, 36 of those paths no longer
 * existed, and it still carried a whole deleted invite-code subsystem. Meanwhile `docs/CURSOR.md`
 * told every reader — person or agent — to "open @INDEX.md first" to find where something lives.
 *
 * A rule that depends on remembering is the rule that breaks. This test makes forgetting loud:
 * add, move or delete a source file without running `npm run index` and it fails, naming the
 * paths that moved.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = join(__dirname, "..", "..");

describe("INDEX.md", () => {
  test("matches the files on disk", () => {
    try {
      execFileSync("node", [join(ROOT, "scripts/build-index.mjs"), "--check"], { cwd: ROOT, encoding: "utf8" });
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string };
      // The generator prints each path that appeared or vanished; surface that, not "exit code 1".
      throw new Error(`${e.stderr ?? ""}${e.stdout ?? ""}`.trim() || "INDEX.md is out of date. Run `npm run index`.");
    }
  });
});
