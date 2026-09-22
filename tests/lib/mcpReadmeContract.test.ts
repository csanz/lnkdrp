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
 * A later pass found the same rot in the reply shapes themselves. `lnkdrp_replace_pdf` named
 * neither `docArchived` nor `supersededBy` - the two fields that say the `shareUrl` in the same
 * reply serves something other than what the call stored - `lnkdrp_get_share_stats` named neither
 * half of the archived pair, `lnkdrp_list_share_links` omitted `total`, the two link writes omitted
 * `docArchived`, and `lnkdrp_list_project_links` still described `publicPageEnabled` as the stored
 * `Project.shareEnabled` switch that the tool had stopped trusting. Round numbers rot the same way:
 * the set_share_access warning was written up as two outcomes when the ladder had grown to five.
 *
 * docs/MCP.md is guarded against the same drift by mcpIdempotencyDocs.test.ts. The README was not,
 * which is how it fell behind. These tests read the sources, not a hand-kept list: every fact
 * compared below is parsed out of the TypeScript that produces it, so a new reply field, a sixth
 * warning branch or a fifteenth error code fails here without anyone having to remember this file.
 * A table that restated the same string twice would guard nothing, which is the whole point.
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

/* -------------------------------------------------------------------------------------------- *
 * Reading a reply shape out of the TypeScript that builds it.
 *
 * Everything below derives its expectation by parsing, because the alternative - a list of field
 * names kept here by hand - is the same list the README already keeps by hand, and two copies of a
 * stale fact agree with each other perfectly. The parser is deliberately small and knows only the
 * idioms these tools actually use to assemble a reply: plain keys, an inline conditional spread
 * (`...(cond ? { key } : {})`), and a spread of a local const or of a helper whose return type
 * names its keys (`...archiveFields(…)`). Anything it cannot resolve - `...value` out of a
 * destructuring, say - contributes nothing rather than guessing.
 * -------------------------------------------------------------------------------------------- */

/**
 * Blank out comment bodies, and optionally string bodies, keeping every offset.
 *
 * Both are full of braces here: a JSDoc block sits between two keys of nearly every reply literal,
 * and `ARCHIVED_DOC_WARNING` contains the sentence "lnkdrp_archive_doc { archived: false }". Naive
 * brace counting reads that sentence as an object and invents an `archived` field. Offsets are kept
 * so a range found in the blanked copy can be sliced out of the original when the prose itself is
 * what a check is after.
 */
function blank(src: string, strings: boolean): string {
  const out = src.split("");
  const erase = (from: number, to: number) => {
    for (let j = from; j < to && j < src.length; j++) if (src[j] !== "\n") out[j] = " ";
  };
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      erase(i, stop);
      i = stop;
      continue;
    }
    if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      erase(i, stop);
      i = stop;
      continue;
    }
    /**
     * A regex literal is consumed whole, before the quote scanner can see inside it.
     *
     * Without this, a regex carrying a quote opened a phantom string that ran to the next quote in
     * the file and blanked everything between - `.replace(/[\\/:*?"<>|]+/g, "_")` in sharePdf.ts
     * swallows twelve lines and the `export function` that follows them. The damage is quiet: the
     * only guard is that a parsed tool yields at least one key, so one swallowed `return { … }`
     * among several still leaves the count above zero and the shape test passes on a partial
     * answer, which is exactly the drift this file exists to catch.
     *
     * Division is the ambiguity. `/` starts a literal only where a value cannot already have
     * ended - after `=`, `(`, `,`, `:`, `[`, `!`, `&`, `|`, `?`, `{`, `;`, `return` or the start
     * of the file - which is the same rule a tokeniser uses and is exact for this codebase.
     */
    if (src[i] === "/" && regexCanStartAt(src, i)) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const ch = src[j];
        if (ch === "\\") { j += 2; continue; }
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) break;
        else if (ch === "\n") break; // unterminated: not a literal after all
        j++;
      }
      if (src[j] === "/") {
        erase(i, j + 1);
        i = j + 1;
        continue;
      }
    }
    const quote = src[i];
    if (quote === '"' || quote === "'" || quote === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== quote) j += src[j] === "\\" ? 2 : 1;
      if (strings) erase(i + 1, j);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** Whether a `/` at `i` opens a regex literal rather than dividing. */
function regexCanStartAt(src: string, i: number): boolean {
  let k = i - 1;
  while (k >= 0 && /\s/.test(src[k]!)) k--;
  if (k < 0) return true;
  const prev = src[k]!;
  if ("=(,:[!&|?{;+-*%~^".includes(prev)) return true;
  // `return /…/`, `typeof /…/` and friends: a keyword cannot be divided.
  const word = src.slice(Math.max(0, k - 9), k + 1).match(/[A-Za-z]+$/);
  return word ? ["return", "typeof", "case", "in", "of", "do", "else", "yield", "await"].includes(word[0]) : false;
}

/** The balanced `{ … }` group opening at `open`, braces only (strings and comments are blanked). */
function group(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return code.slice(open, i + 1);
  }
  throw new Error(`unbalanced { at ${open}`);
}

/** Split a group's inner text on its own `,`/`;`, ignoring anything nested. */
function parts(inner: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    else if ((c === "," || c === ";") && depth === 0) {
      found.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  found.push(inner.slice(start));
  return found.map((p) => p.trim()).filter(Boolean);
}

/** Every `{ … }` group at brace depth 0 of `text`. */
function groupsIn(text: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === "}" && --depth === 0) {
      found.push(text.slice(start, i + 1));
    }
  }
  return found;
}

/** The keys an object literal (or an object type) declares at its top level. */
function literalKeys(text: string, code: string, depth = 0): string[] {
  const keys: string[] = [];
  for (const part of parts(text.slice(1, -1))) {
    if (part.startsWith("...")) {
      keys.push(...spreadKeys(part, code, depth));
      continue;
    }
    const name = /^([A-Za-z_$][\w$]*)\s*(:|$)/.exec(part);
    if (name) keys.push(name[1]);
  }
  return keys;
}

/** What a `...` contributes: an inline conditional object, or a named const or helper. */
function spreadKeys(part: string, code: string, depth: number): string[] {
  if (depth > 4) return [];
  const inline = groupsIn(part);
  if (inline.length) return inline.flatMap((g) => literalKeys(g, code, depth + 1));
  const name = /^\.\.\.\s*([A-Za-z_$][\w$]*)/.exec(part);
  return name ? resolveKeys(name[1], code, depth + 1) : [];
}

/** The keys of a local `const name = …` object, or of a `function name(…): { … }` return type. */
function resolveKeys(name: string, code: string, depth: number): string[] {
  const decl = new RegExp("\\bconst " + name + "\\s*=").exec(code);
  if (decl) {
    const from = decl.index + decl[0].length;
    const parsed = parts(code.slice(from, from + 4000));
    return groupsIn(parsed[0] ?? "").flatMap((g) => literalKeys(g, code, depth));
  }
  const fn = new RegExp("\\bfunction " + name + "\\s*\\(").exec(code);
  if (!fn) return [];
  let i = fn.index + fn[0].length - 1;
  let depthParens = 0;
  for (; i < code.length; i++) {
    if (code[i] === "(") depthParens++;
    else if (code[i] === ")" && --depthParens === 0) break;
  }
  const colon = code.indexOf(":", i);
  const brace = code.indexOf("{", i);
  if (colon === -1 || brace === -1 || colon > brace) return [];
  return literalKeys(group(code, brace), code, depth);
}

/** The stretch of a tool file that one `register…Tool` function occupies. */
function registerRegion(code: string, register: string): { from: number; to: number } {
  const from = code.indexOf("export function " + register);
  expect(from, `mcp/src/tools no longer exports ${register}`).toBeGreaterThan(-1);
  const next = code.indexOf("\nexport function ", from + 1);
  return { from, to: next === -1 ? code.length : next };
}

/** Every key every `return { … }` in that region puts on the wire. */
function replyKeysFromSource(file: string, register: string): Set<string> {
  const raw = readFileSync(path.join(TOOLS_DIR, file), "utf8");
  const code = blank(raw, true);
  const { from, to } = registerRegion(code, register);
  const keys = new Set<string>();
  const region = code.slice(from, to);
  for (const match of region.matchAll(/\breturn\s*\{/g)) {
    const open = from + match.index! + match[0].length - 1;
    for (const key of literalKeys(group(code, open), code)) keys.add(key);
  }
  expect(keys.size, `no reply keys parsed out of ${register}`).toBeGreaterThan(0);
  return keys;
}

/* -------------------------------------------------------------------------------------------- *
 * Reading the same shape out of the README.
 * -------------------------------------------------------------------------------------------- */

/** The README's block for one tool: its own `###` section, or its bullet under a shared heading. */
function readmeBlock(anchor: RegExp): string {
  const at = README.search(anchor);
  expect(at, `mcp/README.md has no block matching ${anchor}`).toBeGreaterThan(-1);
  // From the line after the anchor, or a `### ` heading ends its own block on itself.
  const bodyAt = README.indexOf("\n", at) + 1;
  const end = README.slice(bodyAt).search(/^(- |#{2,4} )/m);
  return README.slice(at, end === -1 ? undefined : bodyAt + end);
}

/**
 * The Out shape a block documents: the last backticked `{ … }` introduced by `Out` or an arrow.
 *
 * Introduced-by is what tells a reply shape from the In shape, from a REST body in a flow line, and
 * from the `{ archived: false }` an argument is quoted with, all of which sit in backticks in the
 * same paragraph.
 */
function outKeysFromReadme(block: string): string[] {
  let shape: string | null = null;
  for (const span of block.matchAll(/`([^`]*)`/g)) {
    const text = span[1].trim();
    if (!text.startsWith("{") || !text.endsWith("}")) continue;
    const before = block.slice(Math.max(0, span.index! - 12), span.index!).replace(/\s+/g, " ");
    if (/(→|->|Out:?) $/.test(before)) shape = text;
  }
  expect(shape, "no Out shape found in this README block").toBeTruthy();
  return parts(shape!.slice(1, -1))
    .map((p) => /^([A-Za-z_$][\w$]*)/.exec(p)?.[1])
    .filter((k): k is string => Boolean(k));
}

/**
 * Every tool whose README Out line can be checked against the literal that builds it.
 *
 * The anchor and the function name say *where* to look; nothing here says what the shape is.
 */
const OUT_SHAPES: { tool: string; file: string; register: string; anchor: RegExp }[] = [
  { tool: "replace_pdf", file: "replacePdf.ts", register: "registerReplacePdfTool", anchor: /^### `lnkdrp_replace_pdf`$/m },
  { tool: "get_share_stats", file: "getShareStats.ts", register: "registerGetShareStatsTool", anchor: /^### `lnkdrp_get_share_stats`$/m },
  { tool: "create_share_link", file: "shareLinks.ts", register: "registerCreateShareLinkTool", anchor: /^- create — /m },
  { tool: "list_share_links", file: "shareLinks.ts", register: "registerListShareLinksTool", anchor: /^- list — /m },
  { tool: "update_share_link", file: "shareLinks.ts", register: "registerUpdateShareLinkTool", anchor: /^- update — /m },
  { tool: "delete_share_link", file: "shareLinks.ts", register: "registerDeleteShareLinkTool", anchor: /^- delete — /m },
  { tool: "verify_share_password", file: "shareLinkPassword.ts", register: "registerVerifySharePasswordTool", anchor: /^- confirm a password — /m },
  { tool: "get_share_link_password", file: "shareLinkPassword.ts", register: "registerGetShareLinkPasswordTool", anchor: /^- read a password back — /m },
  { tool: "create_project_link", file: "projectLinks.ts", register: "registerCreateProjectLinkTool", anchor: /^- create_project_link — /m },
  { tool: "list_project_links", file: "projectLinks.ts", register: "registerListProjectLinksTool", anchor: /^- list_project_links — /m },
  { tool: "update_project_link", file: "projectLinks.ts", register: "registerUpdateProjectLinkTool", anchor: /^- update_project_link — /m },
  { tool: "delete_project_link", file: "projectLinks.ts", register: "registerDeleteProjectLinkTool", anchor: /^- delete_project_link — /m },
];

describe("mcp/README.md reply shapes", () => {
  for (const entry of OUT_SHAPES) {
    it(`lnkdrp_${entry.tool}'s Out line names every key the tool returns`, () => {
      const documented = new Set(outKeysFromReadme(readmeBlock(entry.anchor)));
      const missing = [...replyKeysFromSource(entry.file, entry.register)].filter((k) => !documented.has(k)).sort();
      expect(missing, `undocumented in lnkdrp_${entry.tool}'s Out line`).toEqual([]);
    });
  }
});

/* -------------------------------------------------------------------------------------------- *
 * Facts that are not field names.
 * -------------------------------------------------------------------------------------------- */

const ERRORS_RAW = readFileSync(path.join(ROOT, "mcp/src/errors.ts"), "utf8");
const ERRORS_CODE = blank(ERRORS_RAW, false);

/** Every member of the `ToolErrorCode` union, in declaration order. */
function errorCodesFromSource(): string[] {
  const start = ERRORS_CODE.indexOf("export type ToolErrorCode =");
  expect(start, "mcp/src/errors.ts no longer declares ToolErrorCode").toBeGreaterThan(-1);
  const union = ERRORS_CODE.slice(start, ERRORS_CODE.indexOf(";", start));
  return [...union.matchAll(/\|\s*"([a-z_]+)"/g)].map((m) => m[1]);
}

/** The README paragraph that enumerates those codes. */
function codesParagraph(): string {
  const at = README.indexOf("Codes: `");
  expect(at, "mcp/README.md no longer enumerates the error codes").toBeGreaterThan(-1);
  return README.slice(at, README.indexOf("\n\n", at));
}

describe("mcp/README.md error codes", () => {
  it("names every code the mapper can return, in the order they are declared", () => {
    const paragraph = codesParagraph();
    const codes = errorCodesFromSource();
    expect(codes.length, "ToolErrorCode parsed as empty").toBeGreaterThan(5);
    const documented = codes.filter((c) => paragraph.includes("`" + c + "`"));
    expect(documented, "codes missing from the README's Codes paragraph").toEqual(codes);
    // Order too: a reader matching the list against errors.ts should not have to re-sort it.
    const positions = codes.map((c) => paragraph.indexOf("`" + c + "`"));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("names the details a rate-limited error carries", () => {
    // The whole point of the 429 branch is that the wait it computed reaches the agent; a codes
    // list that stops at the name sends it back to guessing a backoff.
    const fn = /function rateLimitedError[\s\S]*?\n}/.exec(ERRORS_CODE);
    expect(fn, "mcp/src/errors.ts no longer has rateLimitedError").toBeTruthy();
    const details = fn![0].indexOf("details:");
    const keys = details === -1 ? [] : literalKeys(group(fn![0], fn![0].indexOf("{", details)), ERRORS_CODE);
    expect(keys.length, "no details keys parsed off the rate-limit branch").toBeGreaterThan(0);
    for (const key of keys) expect(codesParagraph(), `rate_limited detail ${key}`).toContain(key);
  });
});

/** The `lnkdrp_*` tools a stretch of source tells the agent to call. */
function remediesIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\blnkdrp_[a-z_]+/g)].map((m) => m[0]))].sort();
}

/** One named function's text, prose and all, located by balancing braces on the blanked copy. */
function functionText(raw: string, name: string): string {
  const code = blank(raw, true);
  const at = code.indexOf("function " + name);
  expect(at, `no function ${name}`).toBeGreaterThan(-1);
  const body = group(code, code.indexOf("{", code.indexOf(")", at)));
  const start = code.indexOf("{", code.indexOf(")", at));
  return raw.slice(start, start + body.length);
}

describe("mcp/README.md set_share_access warnings", () => {
  const RAW = readFileSync(path.join(TOOLS_DIR, "setShareAccess.ts"), "utf8");
  const LADDER = functionText(RAW, "warningsForSwitchedOn");
  const SECTION = readmeSection("set_share_access");

  it("enumerates as many outcomes as the ladder can return", () => {
    // `return []` is the silent case and is not an outcome anyone has to be told about; every other
    // return hands back a sentence. The README numbers them, so the two counts are comparable
    // without either side naming a figure the other has to be trusted for.
    const branches = [...LADDER.matchAll(/return \[[^\]]/g)].length;
    expect(branches, "warningsForSwitchedOn parsed as having no branches").toBeGreaterThan(1);
    expect([...SECTION.matchAll(/^\d+\. /gm)].length, "numbered outcomes in the README section").toBe(branches);
  });

  it("names every remedy the warnings name", () => {
    // Each branch prescribes a different call, and prescribing the wrong one is how this went
    // wrong before: update_share_link on an archived document reports success and changes nothing.
    for (const tool of remediesIn(LADDER)) {
      expect(new RegExp(tool + "\\b").test(SECTION), `${tool} is missing from the README section`).toBe(true);
    }
  });

  it("names every link status the ladder branches on", () => {
    const statuses = [...new Set([...LADDER.matchAll(/status === "(\w+)"/g)].map((m) => m[1]))];
    expect(statuses.length, "no status branches parsed").toBeGreaterThan(0);
    for (const status of statuses) expect(SECTION, `link status ${status}`).toContain(status);
  });
});

describe("mcp/README.md list_project_links", () => {
  it("names every remedy the derived-vs-stored warning names", () => {
    // `Project.shareEnabled` is a denormalised "at least one link is live" and is recomputed only
    // on a write, so an expired room keeps reporting the page on. The tool answers from the rows
    // instead and says so in `warnings`; a README that still explains the stored flag sends an
    // agent to the page switch, which cannot revive an expired link.
    const raw = readFileSync(path.join(TOOLS_DIR, "projectLinks.ts"), "utf8");
    const code = blank(raw, true);
    const { from, to } = registerRegion(code, "registerListProjectLinksTool");
    const at = code.indexOf("const warnings = staleFlag", from);
    expect(at, "registerListProjectLinksTool no longer derives publicPageEnabled from the rows").toBeGreaterThan(-1);
    const block = readmeBlock(/^- list_project_links — /m);
    for (const tool of remediesIn(raw.slice(at, to))) {
      expect(new RegExp(tool + "\\b").test(block), `${tool} is missing from the README bullet`).toBe(true);
    }
  });
});
