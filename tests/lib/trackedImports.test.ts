/**
 * Every file the app imports must actually be in the repository.
 *
 * A module that exists only in a working tree builds perfectly for the person who wrote it and
 * fails for everyone else — and on the deploy, which is a clean checkout. `entityTitles.ts` sat
 * like that while eleven committed files imported it: `git status` showed one untracked file among
 * several harmless scratch scripts, and nothing else complained, because the file was right there
 * on disk.
 *
 * This is the same check as `realtimeImageClosure`, one level out: that one asks whether the
 * container ships what the server imports, this asks whether the repository does.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, test } from "vitest";

const ROOT = path.resolve(__dirname, "../..");

function git(command: string): string[] {
  return execSync(command, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 }).split("\n").filter(Boolean);
}

function resolveImport(fromFile: string, spec: string): string | null {
  const base = spec.startsWith("@/")
    ? path.join(ROOT, "src", spec.slice(2))
    : path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.relative(ROOT, candidate);
  }
  return null;
}

describe("repository imports", () => {
  test("no tracked file imports a module git does not have", () => {
    const tracked = new Set(git("git ls-files"));
    const sources = git("git ls-files 'src/**/*.ts' 'src/**/*.tsx' 'realtime/**/*.ts'");

    const offenders: string[] = [];
    for (const rel of sources) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      for (const match of src.matchAll(/from\s+["'](@\/[^"']+|\.[^"']+)["']/g)) {
        const target = resolveImport(path.join(ROOT, rel), match[1]);
        // Unresolvable specifiers are a different failure, and tsc already catches those.
        if (!target) continue;
        if (!tracked.has(target)) offenders.push(`${target} (imported by ${rel})`);
      }
    }

    expect([...new Set(offenders)], "untracked modules that a clean checkout would not build").toEqual([]);
  });
});
