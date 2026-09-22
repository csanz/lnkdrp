/**
 * mcp/README.md is the package's own contract, and it drifts where nothing reads it.
 *
 * Two live ones, both found by reading the code next to the prose. The `/healthz` shape said
 * `{ ok, sessions, version, apiUrl }` while the endpoint had been sending `confirmations` since the
 * confirmation gate landed, so the single field that says whether a delete will stop and ask a
 * human was absent from the only shape an operator reads before checking a deployment. And
 * `lnkdrp_set_share_access`'s Out line named only the get_share shape plus `warnings` while the
 * three other keyed tools' Out lines in the same file all carry `replayed?`, which does not read as
 * terseness, it reads as this tool having no such flag.
 *
 * docs/MCP.md is guarded against the same drift by mcpIdempotencyDocs.test.ts. The README was not,
 * which is how it fell behind. These tests read the sources, not a hand-kept list, so a new health
 * field or a fifth idempotent tool fails here without anyone having to remember this file.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const README = readFileSync(path.join(ROOT, "mcp/README.md"), "utf8");
const MAIN = readFileSync(path.join(ROOT, "mcp/src/main.ts"), "utf8");
const TOOLS_DIR = path.join(ROOT, "mcp/src/tools");

/** The keys the `/healthz` handler actually puts on its body. */
function healthFieldsFromSource(): string[] {
  const start = MAIN.indexOf('app.get("/healthz"');
  expect(start, "mcp/src/main.ts no longer registers /healthz").toBeGreaterThan(-1);
  const body = MAIN.slice(start, MAIN.indexOf("});", start));
  return [...body.matchAll(/^\s{6}([a-zA-Z]+):/gm)].map((m) => m[1]);
}

/** The field list the README prints for `/healthz`. */
function healthFieldsFromReadme(): string[] {
  const match = /healthz`[^\n]*→ `\{([^}]*)\}`/.exec(README);
  expect(match, "mcp/README.md no longer documents a /healthz shape").toBeTruthy();
  return match![1]
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
}

/**
 * A tool's stretch of the README. The reference mixes two layouts: the document tools get their own
 * `### ` heading, the grouped ones (projects, links, tags) are list items under a shared heading,
 * and `create_project` is one of those, so both have to be found or the flag check silently passes
 * on a tool it never looked at.
 */
function readmeSection(tool: string): string {
  const heading = new RegExp("^### `lnkdrp_" + tool + "`", "m");
  const headingAt = README.search(heading);
  if (headingAt > -1) {
    const rest = README.slice(README.indexOf("\n", headingAt) + 1);
    const end = rest.search(/^#{2,4} /m);
    return end === -1 ? rest : rest.slice(0, end);
  }
  const item = new RegExp("^- " + tool + "[ —]", "m");
  const itemAt = README.search(item);
  expect(itemAt, `mcp/README.md has no section for lnkdrp_${tool}`).toBeGreaterThan(-1);
  const rest = README.slice(README.indexOf("\n", itemAt) + 1);
  const end = rest.search(/^(- |#{2,4} )/m);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Every tool that wraps itself in the idempotency store, and whether it marks a replay. */
function replayFlagsFromSource(): Map<string, boolean> {
  const found = new Map<string, boolean>();
  for (const file of readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".ts"))) {
    const lines = readFileSync(path.join(TOOLS_DIR, file), "utf8").split("\n");
    lines.forEach((line, i) => {
      const match = /IdempotencyStore\.key\(\s*orgId,\s*"([a-z_]+)"/.exec(line);
      if (!match) return;
      found.set(match[1], /replayed:\s*true/.test(lines.slice(i, i + 40).join("\n")));
    });
  }
  return found;
}

describe("mcp/README.md /healthz shape", () => {
  it("lists every field the endpoint sends, in order", () => {
    expect(healthFieldsFromReadme()).toEqual(healthFieldsFromSource());
  });

  it("says what the confirmations field means", () => {
    // Naming the field is half of it: the value is the answer to "will this server prompt before a
    // delete", and a reader who cannot map "skipped" onto LNKDRP_SKIP_CONFIRMATIONS still cannot
    // check the deployment.
    const health = README.slice(README.indexOf("Health: `curl"));
    const section = health.slice(0, health.indexOf("\n## "));
    expect(section).toContain("LNKDRP_SKIP_CONFIRMATIONS");
    expect(section).toContain('"enforced"');
    expect(section).toContain('"skipped"');
  });
});

describe("mcp/README.md idempotent tools", () => {
  for (const [tool, marksReplay] of replayFlagsFromSource()) {
    it(`documents ${tool}'s replay flag consistently with the code`, () => {
      expect(readmeSection(tool).includes("replayed"), `lnkdrp_${tool}'s README section`).toBe(marksReplay);
    });
  }
});
