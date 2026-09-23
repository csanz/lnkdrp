#!/usr/bin/env node
/**
 * Regenerate INDEX.md, the repo's code map.
 *
 *   npm run index          # rewrite INDEX.md
 *   npm run index -- --check   # exit 1 if it is out of date, printing what moved
 *
 * It used to be maintained by hand, and `.cursorrules` said to update it "in the same change (no
 * exceptions)". It was last touched on 2026-03-05. By 2026-09-23 it listed 413 paths against 762
 * files in src/ alone, 36 of the paths no longer existed, and an entire deleted invite-code
 * subsystem was still in it — so anyone following the instruction to "open INDEX.md first"
 * navigated by a map of a product that had since changed shape.
 *
 * A rule nobody can keep is worse than no rule, so the map is now derived from the filesystem and
 * the file is generated. `tests/lib/indexMap.test.ts` fails when it drifts, which means it cannot
 * fall six months behind again without someone being told.
 *
 * What it deliberately does not do is describe anything. The old file carried hand-written notes
 * ("Props: `variant?`…") that were often the most useful part and are exactly what cannot be
 * generated. Those belong in each file's own header comment, where they sit beside the code they
 * describe and are read by anyone who opens it; `docs/FEATURES.md` remains the map of intent.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "INDEX.md");

/** Directories that hold no source worth mapping. */
const SKIP = new Set(["node_modules", ".next", ".git", "tmp", "dist", "build", "coverage", ".vercel", "public"]);
const CODE = /\.(ts|tsx|mjs|js|jsx)$/;

/**
 * Every file git tracks, or null when git cannot answer.
 *
 * The map has to describe the *repository*, not this working tree. Generating it from the
 * filesystem baked three untracked local-only scripts into the committed INDEX.md, which made
 * `--check` and `tests/lib/indexMap.test.ts` fail for everyone whose working tree was not this
 * one - the same class of mistake as committing an import whose module is untracked, and caught
 * the same way.
 */
function trackedFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
    const files = out.split("\0").filter(Boolean);
    return files.length ? new Set(files) : null;
  } catch {
    // No git (a tarball, a sandbox): fall back to the filesystem rather than produce nothing.
    return null;
  }
}

const TRACKED = trackedFiles();

/** Every source file under `dir`, repo-relative, sorted, with POSIX separators. */
function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(join(ROOT, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(rel));
    else if (CODE.test(e.name) && !e.name.endsWith(".d.ts") && (!TRACKED || TRACKED.has(rel))) out.push(rel);
  }
  return out.sort();
}

/**
 * The exported names of one file.
 *
 * Regex rather than a parser: this is a navigation aid, and a missed re-export costs a reader one
 * extra grep, while a parser would cost a dependency and a build step. Ordered by how often each
 * form appears in this codebase.
 */
function exportsOf(rel) {
  let src;
  try {
    src = readFileSync(join(ROOT, rel), "utf8");
  } catch {
    // A dangling symlink or an unreadable file costs one missing export list, not the code map.
    return [];
  }
  const names = new Set();
  const add = (n) => {
    const name = String(n ?? "").trim();
    if (name && name !== "default" && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
  };

  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm)) add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) add(part.split(/\s+as\s+/).pop());
  }
  const hasDefault = /^export\s+default\b/m.test(src);

  const list = [...names].sort((a, b) => a.localeCompare(b));
  if (hasDefault) list.unshift("default");
  return list;
}

/** A Next.js route path from a file inside src/app, or null when the file is not a route. */
function routePath(rel) {
  const m = rel.match(/^src\/app\/(.*)\/(page|route|layout|opengraph-image|twitter-image|default)\.tsx?$/);
  if (!m) return null;
  const segments = m[1]
    .split("/")
    .filter((s) => s && !(s.startsWith("(") && s.endsWith(")"))) // route groups are not URL segments
    .map((s) => s.replace(/^\[\.\.\.(.+)\]$/, ":$1*").replace(/^\[(.+)\]$/, ":$1"));
  return { url: `/${segments.join("/")}`.replace(/\/$/, "") || "/", kind: m[2] };
}

function section(title, note, files) {
  const lines = [`## ${title}`, ""];
  if (note) lines.push(note, "");
  if (!files.length) {
    lines.push("_none_", "");
    return lines.join("\n");
  }
  for (const rel of files) {
    const names = exportsOf(rel);
    const route = routePath(rel);
    const label = route && route.kind !== "layout" ? ` — \`${route.url}\`` : "";
    const ex = names.length ? ` · ${names.slice(0, 8).join(", ")}${names.length > 8 ? ", …" : ""}` : "";
    lines.push(`- \`${rel}\`${label}${ex}`);
  }
  lines.push("");
  return lines.join("\n");
}

function build() {
  const app = walk("src/app");
  const pages = app.filter((f) => /\/(page|layout|default|opengraph-image|twitter-image)\.tsx?$/.test(f));
  const routes = app.filter((f) => /\/route\.tsx?$/.test(f));
  const appOther = app.filter((f) => !pages.includes(f) && !routes.includes(f));
  const src = walk("src");
  const rest = src.filter((f) => !f.startsWith("src/app/") && !f.startsWith("src/components/") && !f.startsWith("src/lib/"));

  const counted = [...src, ...walk("realtime"), ...walk("mcp/src"), ...walk("scripts"), ...walk("db")].length;

  const body = [
    "# Code map",
    "",
    "**Generated — do not edit by hand.** Run `npm run index` after adding, moving or removing a",
    "file; `npm run index -- --check` (and `tests/lib/indexMap.test.ts`) fail when it is stale.",
    "",
    `Covers ${counted} source files. Each entry is a path, the URL it serves where it is a route,`,
    "and its exported names. For *what a thing is for*, read the file's own header comment, or",
    "`docs/FEATURES.md` for the product map.",
    "",
    section("Pages", "Files under `src/app` that render. Route groups `(name)` are not URL segments.", pages),
    section("API routes", "`route.ts` handlers, with the path each one answers on.", routes),
    section("App-local modules", "Clients, helpers and components that live beside the page that uses them.", appOther),
    section("Components", null, walk("src/components")),
    section("Libraries", "`src/lib` — models, services and pure helpers.", walk("src/lib")),
    section("Other source", null, rest),
    section("Realtime server", null, walk("realtime")),
    section("MCP server", null, walk("mcp/src")),
    section("Scripts", "Run with `npm run <name>`; see the NPM Scripts Reference in `docs/DEV.md`.", walk("scripts")),
    section("Database", null, walk("db")),
  ].join("\n");

  return `${body.replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

const next = build();
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    /* treated as empty: a missing INDEX.md is out of date */
  }
  if (current === next) {
    console.log("INDEX.md is up to date.");
    process.exit(0);
  }
  console.error("INDEX.md is out of date. Run `npm run index`.");
  const currentLines = new Set(current.split("\n"));
  const added = next.split("\n").filter((l) => l.startsWith("- `") && !currentLines.has(l));
  const nextLines = new Set(next.split("\n"));
  const gone = current.split("\n").filter((l) => l.startsWith("- `") && !nextLines.has(l));
  for (const l of gone.slice(0, 20)) console.error(`  - ${l.slice(2)}`);
  for (const l of added.slice(0, 20)) console.error(`  + ${l.slice(2)}`);
  if (gone.length + added.length > 40) console.error(`  … ${gone.length + added.length - 40} more`);
  process.exit(1);
}

writeFileSync(OUT, next);
console.log(`INDEX.md: ${next.split("\n").filter((l) => l.startsWith("- `")).length} files.`);
