/**
 * The realtime image must ship every file its entrypoint imports.
 *
 * `realtime/server.ts` runs as a standalone process from a tiny image with its own dependency
 * list (`realtime/Dockerfile` writes a three-package `package.json` and COPYs three paths). An
 * import that reaches outside that set builds perfectly and then exits on every container start
 * with MODULE_NOT_FOUND, before `main()` runs — no listener, no /healthz, a crash loop, and every
 * browser silently falling back to polling.
 *
 * That is not hypothetical: adding `splitProjectViewerKey` from `share/projectPublic` did exactly
 * this, and the module could not simply be COPYed because it pulls in mongoose models. The rule
 * moved to an import-free leaf instead. This test is the guard that was missing.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = path.resolve(__dirname, "../..");

/** The paths `realtime/Dockerfile` copies into the image. */
function shippedPaths(): string[] {
  const dockerfile = fs.readFileSync(path.join(ROOT, "realtime/Dockerfile"), "utf8");
  return dockerfile
    .split("\n")
    .filter((line) => line.startsWith("COPY "))
    .map((line) => line.split(/\s+/)[1])
    .filter((p) => p && !p.startsWith("--"));
}

function resolveImport(fromFile: string, spec: string): string | null {
  const base = spec.startsWith("@/")
    ? path.join(ROOT, "src", spec.slice(2))
    : path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every repo file reachable from `realtime/server.ts` by a runtime import. */
function reachableFiles(): { files: Set<string>; unresolved: string[] } {
  const files = new Set<string>();
  const unresolved: string[] = [];
  const walk = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    const src = fs.readFileSync(file, "utf8");
    for (const match of src.matchAll(/(?:^|\n)\s*import\s+(?:type\s+)?[^"']*from\s+["']([^"']+)["']/g)) {
      // Bare specifiers are npm packages, which the image installs from its own package.json.
      const spec = match[1];
      if (!spec.startsWith(".") && !spec.startsWith("@/")) continue;
      // `import type` is erased before the code ever runs.
      if (/^\s*import\s+type\s/.test(match[0].replace(/^\n/, ""))) continue;
      const target = resolveImport(file, spec);
      if (!target) {
        unresolved.push(`${path.relative(ROOT, file)} -> ${spec}`);
        continue;
      }
      walk(target);
    }
  };
  walk(path.join(ROOT, "realtime/server.ts"));
  return { files, unresolved };
}

describe("realtime image", () => {
  test("every module the server imports is copied into the image", () => {
    const shipped = shippedPaths();
    const { files, unresolved } = reachableFiles();
    expect(unresolved).toEqual([]);

    const notShipped = [...files]
      .map((file) => path.relative(ROOT, file))
      .filter((rel) => !shipped.some((s) => rel === s || rel.startsWith(`${s.replace(/\/$/, "")}/`)));

    // The failure message names the file, because the fix is a judgement call: COPY it when it is
    // a leaf, and move the part you need out of it when it is not.
    expect(notShipped, `not in realtime/Dockerfile's COPY list: ${notShipped.join(", ")}`).toEqual([]);
  });

  test("nothing it imports drags in a database model or the app's mongoose connection", () => {
    const { files } = reachableFiles();
    const heavy = [...files]
      .map((file) => path.relative(ROOT, file))
      .filter((rel) => /^src\/lib\/(models|mongodb)/.test(rel));
    expect(heavy, `the realtime image must stay free of ${heavy.join(", ")}`).toEqual([]);
  });
});
