/**
 * Both service images must ship every file their entrypoint imports.
 *
 * `realtime/server.ts` and `mcp/src/main.ts` run as standalone processes from tiny images with
 * their own dependency lists — each Dockerfile writes a small `package.json` and COPYs a handful
 * of paths out of `src/lib`. An import that reaches outside that set builds perfectly and then
 * exits on every container start with MODULE_NOT_FOUND, before the entrypoint runs: a crash loop,
 * no health endpoint, and a feature that is simply missing in production.
 *
 * It has happened twice. `mcp/Dockerfile` had to be taught to copy `src/lib/limits/uploads.ts`,
 * and DEPLOY.md's known-gaps section recorded the remaining hazard in as many words — "nothing
 * checks that the COPY list covers what `mcp/src` imports out of `src/lib` ... so the next such
 * import breaks the image the same silent way". The next one was realtime importing
 * `share/projectPublic`, which could not simply be COPYed because it drags mongoose models behind
 * it; the rule moved to an import-free leaf instead. This is that missing check.
 *
 * `import type` is ignored: it is erased before the code runs, which is why the MCP may name
 * `ActivityType` from a module its image does not carry.
 *
 * The entrypoint each image is walked from is the one its `CMD` actually runs, and a test below
 * asserts that. This check spent a while walking `mcp/src/server.ts`, which is not the MCP's
 * `CMD` — `main.ts` is — and which only `import type`s `./api`, so the whole `ApiClient` import
 * graph (every `src/lib` module the tools reach for) sat outside the walk and the gate passed on
 * an image that could not boot. Walking the wrong file is the one way this check fails silently,
 * so the file it walks is tied to the Dockerfile rather than written down twice.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = path.resolve(__dirname, "../..");

/**
 * The two standalone services, each with the Dockerfile that packages it and the entrypoint that
 * Dockerfile's `CMD` runs — not the file that merely looks like the server.
 */
const IMAGES = [
  { name: "realtime", dockerfile: "realtime/Dockerfile", entry: "realtime/server.ts" },
  { name: "mcp", dockerfile: "mcp/Dockerfile", entry: "mcp/src/main.ts" },
] as const;

/**
 * The script a Dockerfile's `CMD` runs, so the walk can be pinned to it.
 *
 * Both are exec-form `CMD ["node", "--import", "tsx", "<entry>"]`; the entry is the last element,
 * the only one that is a repo path.
 */
function cmdEntry(dockerfile: string): string | null {
  const contents = fs.readFileSync(path.join(ROOT, dockerfile), "utf8");
  const line = contents.split("\n").find((l) => l.startsWith("CMD ["));
  if (!line) return null;
  const parts = [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const last = parts[parts.length - 1];
  return last && /\.(ts|tsx|js|mjs)$/.test(last) ? last : null;
}

/** The paths a Dockerfile copies into its image. */
function shippedPaths(dockerfile: string): string[] {
  const contents = fs.readFileSync(path.join(ROOT, dockerfile), "utf8");
  return contents
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

/** Every repo file reachable from an entrypoint by a runtime import. */
function reachableFiles(entry: string): { files: Set<string>; unresolved: string[] } {
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
  walk(path.join(ROOT, entry));
  return { files, unresolved };
}

describe.each(IMAGES)("$name image", ({ dockerfile, entry, name }) => {
  // Without this the whole check can go quietly blind: walking anything but the file the container
  // runs proves nothing about the container, and nothing else would notice.
  test("the entrypoint walked below is the one the image's CMD runs", () => {
    expect(cmdEntry(dockerfile), `${dockerfile}'s CMD must run ${entry}`).toBe(entry);
  });

  test("every module the entrypoint imports is copied into the image", () => {
    const shipped = shippedPaths(dockerfile);
    const { files, unresolved } = reachableFiles(entry);
    expect(unresolved).toEqual([]);

    // Dockerfile COPY paths are always forward-slash; `path.relative` is not on Windows.
    const notShipped = [...files]
      .map((file) => path.relative(ROOT, file).split(path.sep).join("/"))
      .filter((rel) => !shipped.some((s) => rel === s || rel.startsWith(`${s.replace(/\/$/, "")}/`)));

    // The failure names the files, because the fix is a judgement call: COPY it when it is a leaf,
    // and move the part you need out of it when it is not.
    expect(notShipped, `not in ${dockerfile}'s COPY list: ${notShipped.join(", ")}`).toEqual([]);
  });

  test("nothing it imports drags in a database model or the app's mongoose connection", () => {
    const { files } = reachableFiles(entry);
    // Posix separators, as in the sibling test: on Windows `path.relative` answers with backslashes
    // and this regex matched nothing, so the assertion passed with an empty list.
    const heavy = [...files]
      .map((file) => path.relative(ROOT, file).split(path.sep).join("/"))
      .filter((rel) => /^src\/lib\/(models|mongodb)/.test(rel));
    expect(heavy, `the ${name} image must stay free of ${heavy.join(", ")}`).toEqual([]);
  });
});
