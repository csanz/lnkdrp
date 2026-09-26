/**
 * Nothing changes for recipients (docs/prds/lnkdrp-locked-projects.md, decision 25,
 * Verification 3 and 12).
 *
 * A data room's public link is how the product works. It keeps working for the people it was sent
 * to whether the room is locked or not, so the recipient half of the product must never learn what
 * a lock is: `/p/:shareId` resolves the same way, with the same refusal states
 * (`archived`, `disabled`, `expired`, `project_gone`, which gain no fifth value), the same password
 * and share-auth behaviour, the same document list, the same PDF and preview routes, and the same
 * `ShareView`, `ProjectLinkView`, `DocPageTiming` and activity writes.
 *
 * Pinned as an anti-import, exactly as `tests/lib/containedDocListings.test.ts` asserts that
 * `projectPublic.ts` does not import `workspaceListableDocFilter`. The failure this prevents is not
 * a leak, it is the opposite: a well-meaning refactor that threads the visibility clause into the
 * recipient path and breaks every data room link a locked workspace has already sent. There is no
 * actor on these paths to hold a grant, so the clause would resolve to "no grants" and refuse
 * everybody.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

const ROOT = path.resolve(__dirname, "../..");

/** Either helper: the clause itself, and the grant read it is built from. */
const LOCK_IMPORT_RX = /from\s*["']@\/lib\/projects\/lockScope["']/;

/** The recipient surfaces named in decision 25, each of which must stay lock-free. */
const RECIPIENT_FILES = [
  "src/lib/share/projectLinks.ts",
  "src/lib/share/projectPublic.ts",
  "src/app/api/requests/[token]/uploads/route.ts",
  "src/app/api/requests/[token]/guide/route.ts",
  "src/app/api/request-view/[token]/docs/[docId]/pdf/route.ts",
  "src/app/r/[token]/page.tsx",
  "src/app/request-view/[token]/page.tsx",
];

function* filesUnder(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* filesUnder(p);
    else if (/\.tsx?$/.test(entry.name)) yield p;
  }
}

function rel(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

describe("the recipient half never learns what a lock is", () => {
  test.each(RECIPIENT_FILES)("%s does not import lockScope", (file) => {
    const full = path.join(ROOT, file);
    expect(existsSync(full), `${file} has moved; update this contract rather than deleting the assertion`).toBe(true);
    const src = readFileSync(full, "utf8");
    expect(src, `${file} is a recipient surface and must resolve without an actor`).not.toMatch(LOCK_IMPORT_RX);
    expect(src).not.toContain("projectGrantIds");
    expect(src).not.toContain("projectVisibilityClause");
    expect(src).not.toContain("hiddenProjectIds");
  });

  test("nothing under src/app/p/** imports lockScope", () => {
    const dir = path.join(ROOT, "src/app/p");
    expect(existsSync(dir)).toBe(true);
    const offenders = [...filesUnder(dir)].filter((f) => LOCK_IMPORT_RX.test(readFileSync(f, "utf8"))).map(rel);
    expect(
      offenders,
      `the public data room pages must resolve for an anonymous visitor:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  test("nothing under src/app/api/share/** or src/app/api/download/** imports lockScope", () => {
    const offenders: string[] = [];
    for (const d of ["src/app/api/share", "src/app/api/download", "src/app/api/request-view"]) {
      const dir = path.join(ROOT, d);
      if (!existsSync(dir)) continue;
      for (const f of filesUnder(dir)) if (LOCK_IMPORT_RX.test(readFileSync(f, "utf8"))) offenders.push(rel(f));
    }
    expect(offenders, `recipient capability routes must stay lock-free:\n${offenders.join("\n")}`).toEqual([]);
  });

  test("the refusal set gains no fifth value", () => {
    // A locked room is not a refusal state: for the recipient it is an ordinary room. A fifth value
    // here would be the lock leaking out of the workspace and into the public page.
    const src = readFileSync(path.join(ROOT, "src/lib/share/projectPublic.ts"), "utf8");
    expect(src).not.toContain('"locked"');
    expect(src).not.toContain("project_locked");
  });
});
