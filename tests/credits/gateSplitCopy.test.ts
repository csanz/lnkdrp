import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Since 2026-09-13 the owner's version history and AI compare run on credits on every plan; only
 * letting recipients browse versions is Pro. This fails when app copy says otherwise again.
 */
const ROOT = path.resolve(__dirname, "../../src");
const STALE = [
  /version history (and AI compare )?(is|are) (a )?Pro/i,
  /AI compare (is|are) (a )?Pro/i,
  /Not on Free: version history/i,
  /version history and AI compare are not available/i,
  /Version history and AI compare are Pro features/i,
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe("gate split copy", () => {
  test("no surface calls owner version history or AI compare a Pro feature", () => {
    const hits: string[] = [];
    for (const file of files(ROOT)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (STALE.some((re) => re.test(line))) hits.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
