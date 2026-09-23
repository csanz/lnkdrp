/**
 * A `quality` prop that the optimiser is not allowed to serve.
 *
 * Next 16 defaults `images.qualities` to `[75]` and serves 75 for anything not listed — no warning,
 * no error, no failed build. `ProductShots.tsx` had passed `quality={90}` since the day it was
 * written, for a stated reason (at 75 the compressor spends its budget on the large flat areas of a
 * screenshot and takes it out of the 11px labels, which is the only part of a product shot anyone
 * is trying to read), and the page had been serving 75 the whole time. Found by reading the live
 * page's markup, not the source: `?url=/images/home/agents.png&w=1920&q=75`.
 *
 * That is the worst shape a bug can have — the code says one thing, the deploy does another, and
 * nothing anywhere disagrees. So the allowlist is checked against the props rather than trusted.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

const ROOT = path.resolve(__dirname, "../..");

/** Every `.ts`/`.tsx` under `src/`, walked from disk. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Every `quality={N}` passed to an image in the app.
 *
 * Walks the working tree rather than `git ls-files` on purpose: a component that is written but not
 * yet committed is exactly the case this test exists for — the one that shipped a prop the deploy
 * would ignore — and a git-only scan would not see it until after the mistake had landed.
 */
function qualitiesUsed(): Array<{ file: string; quality: number }> {
  const out: Array<{ file: string; quality: number }> = [];
  for (const full of sourceFiles(path.join(ROOT, "src"))) {
    const src = fs.readFileSync(full, "utf8");
    for (const m of src.matchAll(/quality=\{(\d+)\}/g)) {
      out.push({ file: path.relative(ROOT, full), quality: Number(m[1]) });
    }
  }
  return out;
}

/** The values `next.config.ts` permits, read from the file rather than imported (it is TS config). */
function qualitiesAllowed(): number[] {
  const config = fs.readFileSync(path.join(ROOT, "next.config.ts"), "utf8");
  const m = /qualities:\s*\[([^\]]*)\]/.exec(config);
  if (!m) return [75];
  return m[1]
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isFinite(n));
}

describe("next/image quality", () => {
  test("every quality a component asks for is one the optimiser may serve", () => {
    const allowed = new Set(qualitiesAllowed());
    const unserved = qualitiesUsed()
      .filter((u) => !allowed.has(u.quality))
      .map((u) => `${u.file}: quality={${u.quality}}`);
    expect(
      unserved,
      "these would be silently downgraded to 75 — add the value to images.qualities in next.config.ts",
    ).toEqual([]);
  });

  test("the allowlist is not padded with values nothing uses", () => {
    // Each entry is a variant the optimiser may be asked to generate and cache, so the list should
    // be the values actually in use, plus Next's own default.
    const used = new Set(qualitiesUsed().map((u) => u.quality));
    used.add(75);
    const unused = qualitiesAllowed().filter((q) => !used.has(q));
    expect(unused, "qualities nothing passes; remove them").toEqual([]);
  });

  test("75 stays allowed, because it is what every image without the prop asks for", () => {
    expect(qualitiesAllowed()).toContain(75);
  });
});
