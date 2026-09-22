/**
 * The tags manager's own state, checked for the three ways it was lying to the person using it.
 *
 * All three were half-wired: a piece of state declared with a comment explaining the question it
 * answers, and then never written to or never read. That shape is invisible in review (the
 * comment reads as the behaviour) and invisible at runtime too, because the component still
 * renders. What it produced was a Merge button permanently disabled under "Nothing to merge into
 * yet" in every workspace, a stale-response guard that guarded nothing, and a New tag dialog that
 * closed on a duplicate without saying so.
 *
 * Nothing here renders React (these suites run in `node`), so the structural properties are read
 * off the source, the way `tagsDiscoverable` does. The first of them is deliberately general:
 * "a setter that is never called" is the class of bug, not just `setWorkspaceTotal`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { readCreateResult } from "@/components/tags/TagsManager";

const ROOT = join(__dirname, "..", "..");
const SOURCE = "src/components/tags/TagsManager.tsx";
const src = readFileSync(join(ROOT, SOURCE), "utf8");

/** The body of a top-level `const name = useCallback(async () => {` / `async function name(` . */
function bodyOf(header: string): string {
  const at = src.indexOf(header);
  expect(at, `${header} is no longer in ${SOURCE}`).toBeGreaterThan(-1);
  const open = src.indexOf("{", at + header.length - 1);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`Could not find the end of ${header}`);
}

describe("no piece of state is declared and then left unwritten", () => {
  test("every useState setter in the manager is called somewhere", () => {
    // `workspaceTotal` was the one: declared, commented ("what 'is there anything to merge into'
    // actually asks"), read by the Merge button's `disabled` and `title`, and never set. Frozen at
    // 0, `workspaceTotal < 2` is a constant true, so merge was unreachable everywhere, and `/tags`
    // is the only surface that offers it.
    const setters = [...src.matchAll(/const \[[A-Za-z0-9_]+, (set[A-Za-z0-9_]+)\] = useState/g)].map((m) => m[1]);
    expect(setters.length).toBeGreaterThan(5);
    const unwritten = setters.filter((setter) => {
      const uses = src.match(new RegExp(`\\b${setter}\\b`, "g")) ?? [];
      return uses.length < 2; // the declaration itself is one
    });
    expect(unwritten).toEqual([]);
  });

  test("the merge gate has a source that is not the filtered page total", () => {
    // Filtered, `total` counts matches: search down to one row and a `setWorkspaceTotal(total)`
    // written without that distinction would disable merge on a workspace of hundreds.
    const load = bodyOf("const load = useCallback(");
    expect(load).toMatch(/if\s*\(!q\)\s*setWorkspaceTotal\(/);
    expect(src).toContain("limit=1");
  });
});

describe("the request-sequence guard is applied, not just taken", () => {
  const load = bodyOf("const load = useCallback(");

  test("`mine` is read back, not only assigned", () => {
    expect(load).toContain("const mine = ++seq.current;");
    const reads = load.match(/mine !== seq\.current/g) ?? [];
    expect(reads.length).toBeGreaterThanOrEqual(3); // ok, !ok and catch all write state
  });

  test("no state write in `load` happens before the guard", () => {
    // The failure it prevents: from page 2 a keystroke issues the unfiltered request first and the
    // `q=` one 250ms later, so a slow unfiltered response lands second and replaces the search the
    // person is reading, with the footer then describing the workspace total.
    const writes = [...load.matchAll(/set(?:Tags|Total|WorkspaceTotal)\(/g)].map((m) => m.index ?? 0);
    expect(writes.length).toBeGreaterThan(0);
    for (const at of writes) {
      const guardedAt = load.lastIndexOf("mine !== seq.current", at);
      expect(guardedAt, `a state write at ${at} in load() is not behind the sequence guard`).toBeGreaterThan(-1);
    }
  });
});

describe("a New tag name that folds onto an existing tag", () => {
  test("`created: false` is an existing tag, not a new one", () => {
    // `POST /api/tags` is find-or-create by design, so this is the reply for "fundraising" typed
    // where "Fundraising" lives. `res.ok` alone cannot tell the two apart.
    expect(readCreateResult({ created: false, tag: { id: "t1", name: "Fundraising" } })).toEqual({
      kind: "exists",
      name: "Fundraising",
    });
  });

  test("`created: true` is the tag that was just made", () => {
    expect(readCreateResult({ created: true, tag: { id: "t2", name: "Diligence" } })).toEqual({
      kind: "created",
      name: "Diligence",
    });
  });

  test("a reply with no usable tag claims nothing", () => {
    // Older deployments, or a body that failed to parse: better to close quietly than to announce
    // a duplicate that may not exist.
    expect(readCreateResult(null)).toEqual({ kind: "unknown" });
    expect(readCreateResult({ created: false, tag: null })).toEqual({ kind: "unknown" });
    expect(readCreateResult({ created: false, tag: { id: "t3", name: "   " } })).toEqual({ kind: "unknown" });
  });

  test("the dialog stays open on a duplicate instead of closing on silence", () => {
    const create = bodyOf("async function create()");
    const exists = create.indexOf('outcome.kind === "exists"');
    const closes = create.indexOf("setAdding(false)");
    expect(exists).toBeGreaterThan(-1);
    expect(closes).toBeGreaterThan(exists);
    // It has to leave before closing, or the branch is decoration.
    expect(create.slice(exists, closes)).toContain("return;");
    expect(create.slice(exists, closes)).toContain("already exists");
  });

  test("a tag that was created is brought on screen", () => {
    // Created from page 2, or under a filter it does not match, it was made and then invisible,
    // which reads exactly like the button did nothing.
    const create = bodyOf("async function create()");
    const made = create.indexOf('outcome.kind === "created"');
    expect(made).toBeGreaterThan(-1);
    expect(create.slice(made)).toMatch(/setFilter\(outcome\.name\)/);
  });
});
