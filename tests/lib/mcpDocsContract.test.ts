/**
 * docs/MCP.md has to describe the tools the MCP server actually registers.
 *
 * It is the reference a client author builds an exhaustive switch from and the one a maintainer
 * opens before touching a tool, and it drifted ten ways at once: four result fields that shipped
 * without ever reaching an `Out:` line, an error code the table never listed, a `linkStatus` value
 * outside the documented enum, a confirmation severity whose rule had been replaced, a closed
 * "two outcomes" enumeration against a five-branch ladder, a project flag the code had stopped
 * trusting, and an e2e section two commits behind its harness. Every one of them was written true
 * and left behind by the commit that changed the code, which is why nothing caught them: a doc
 * nobody executes rots quietly, and the reader who finds out is the one who trusted it.
 *
 * So these read the sources and the doc and fail when the two disagree. The facts are derived on
 * both sides on purpose - a tool that gains a result field, an error code, a status value or a
 * warning branch fails here without anyone having to remember this file - and sibling
 * `mcpIdempotencyDocs.test.ts` does the same for the idempotency table.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const DOC = readFileSync(path.join(ROOT, "docs/MCP.md"), "utf8");
const TOOLS_DIR = path.join(ROOT, "mcp/src/tools");
const ERRORS_SRC = readFileSync(path.join(ROOT, "mcp/src/errors.ts"), "utf8");
const E2E_SRC = readFileSync(path.join(ROOT, "tests/mcp/e2e.ts"), "utf8");

/**
 * Each tool's own slice of its source file: `server.registerTool("lnkdrp_x", …)` up to the next
 * registration. Three or four tools share one file, so a file-wide grep would credit `list` with
 * `create`'s fields; the slice is what keeps "this tool emits it" an answer about this tool.
 */
function toolSources(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(path.join(TOOLS_DIR, file), "utf8");
    const marks: Array<[string, number]> = [];
    const re = /server\.registerTool\(\s*\n\s*"(lnkdrp_[a-z_]+)"/g;
    for (let m = re.exec(src); m; m = re.exec(src)) marks.push([m[1], m.index]);
    marks.forEach(([name, at], i) => {
      found.set(name, src.slice(at, i + 1 < marks.length ? marks[i + 1][1] : src.length));
    });
  }
  return found;
}

/** A tool's section of the reference, heading to next heading. */
function docSection(tool: string): string {
  const start = DOC.search(new RegExp(`^#{3,4} \`${tool}\``, "m"));
  expect(start, `docs/MCP.md has no section for ${tool}`).toBeGreaterThan(-1);
  const rest = DOC.slice(DOC.indexOf("\n", start) + 1);
  const end = rest.search(/^#{2,4} /m);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The bullet that gives the result shape, continuation lines and all. A bullet ends where the next
 * one starts at column zero; everything indented under it is still the shape's own prose, which is
 * where the optional fields get explained. The shorter sections put `Out:` on the end of the `In:`
 * bullet rather than on one of its own, so this looks for the bullet that carries it.
 */
function outBullet(tool: string): string {
  const section = docSection(tool);
  const bullets = section.split(/\n(?=- )/);
  const match = bullets.find((b) => /^- (?:\*\*)?(?:In:[\s\S]*?)?Out:/.test(b));
  expect(match, `${tool} has no bullet giving an Out shape`).toBeTruthy();
  return match!;
}

const SOURCES = toolSources();

describe("docs/MCP.md result shapes", () => {
  /**
   * Fields a caller has to branch on, and that the `Out:` line is the only place to learn.
   *
   * Each row names the line in the tool's own slice that puts the field on the wire, so the check
   * runs both ways: drop the field from the code and the row stops matching, which fails just as
   * loudly as the doc omitting one. The `emitted` pattern is written out rather than inferred from
   * the field name because these arrive four different ways - a spread, a conditional object, a
   * shorthand key and a helper call - and a pattern loose enough to catch all four also catches
   * the input argument of the same name.
   */
  const SHAPE_FACTS: Array<{ tool: string; field: string; emitted: RegExp; why: string }> = [
    {
      tool: "lnkdrp_replace_pdf",
      field: "docArchived",
      emitted: /archiveFields\(/,
      why: "a replacement on an archived document hands back a shareUrl that resolves for nobody",
    },
    {
      tool: "lnkdrp_get_share_stats",
      field: "downloadsEnabled",
      emitted: /downloadsEnabled: stats\.downloadsEnabled/,
      why: "the only field that tells `downloads: 0` apart from downloads being off",
    },
    {
      tool: "lnkdrp_get_share_stats",
      field: "isArchived",
      emitted: /isArchived: true,/,
      why: "says the figures are history rather than a live picture",
    },
    {
      tool: "lnkdrp_list_share_links",
      field: "total",
      emitted: /total: page\.total/,
      why: "how a reader knows a 100-link page is short rather than complete",
    },
    {
      tool: "lnkdrp_create_share_link",
      field: "docArchived",
      emitted: /\.\.\.\(doc\.isArchived \? \{ docArchived: true \} : \{\}\)/,
      why: "the link just created opens for nobody",
    },
    {
      tool: "lnkdrp_update_share_link",
      field: "docArchived",
      emitted: /\.\.\.\(doc\.isArchived \? \{ docArchived: true \} : \{\}\)/,
      why: "whatever the call just set, the link opens for nobody",
    },
    {
      tool: "lnkdrp_verify_share_password",
      field: "isArchived",
      emitted: /isArchived: true as const/,
      why: "the one case where opensLink is false for a reason the link row does not show",
    },
    {
      tool: "lnkdrp_list_project_links",
      field: "warnings",
      emitted: /\.\.\.\(warnings\.length \? \{ warnings \} : \{\}\)/,
      why: "the only place the derived page state and the stored flag are reconciled",
    },
  ];

  for (const fact of SHAPE_FACTS) {
    it(`${fact.tool}'s Out shape carries ${fact.field}: ${fact.why}`, () => {
      const src = SOURCES.get(fact.tool);
      expect(src, `no registration found for ${fact.tool}`).toBeTruthy();
      const emits = fact.emitted.test(src!);
      expect(new RegExp(`\\b${fact.field}\\b`).test(outBullet(fact.tool)), `${fact.tool}'s Out shape`).toBe(emits);
    });
  }
});

describe("docs/MCP.md error table", () => {
  /** The union is the wire contract; the table presents itself as that enumeration. */
  const union = (() => {
    // To the blank line before the next declaration, not to the first `;`: the union carries a
    // doc comment whose prose has semicolons in it.
    const block = /export type ToolErrorCode =([\s\S]*?);\n\n/.exec(ERRORS_SRC);
    expect(block, "errors.ts has no ToolErrorCode union").toBeTruthy();
    return [...block![1].matchAll(/\|\s*"([a-z_]+)"/g)].map((m) => m[1]);
  })();

  const rows = (() => {
    const table = DOC.split("\n## Errors\n")[1];
    expect(table, "docs/MCP.md has no '## Errors' section").toBeTruthy();
    return [...table.split("\n## ")[0].matchAll(/^\|\s*`([a-z_]+)`\s*\|/gm)].map((m) => m[1]);
  })();

  it("has a row for every code the server can return, and no others", () => {
    // `owner_removed` was missing for two rounds: a caller switching on the table had no arm for
    // a valid key whose creating member was removed, and the nearest row it fell through to
    // ("unauthorized") prescribes a new key - the one remedy that cannot work here.
    expect([...rows].sort()).toEqual([...union].sort());
  });

  it("tells a rate-limited caller how long to wait, when the code sends it", () => {
    const sendsRetryAfter = /details:\s*retryAfter !== null \? \{ retryAfterSeconds: retryAfter \}/.test(ERRORS_SRC);
    const table = DOC.split("\n## Errors\n")[1].split("\n## ")[0];
    const row = /^\|\s*`rate_limited`\s*\|.*$/m.exec(table);
    expect(row, "no rate_limited row").toBeTruthy();
    expect(row![0].includes("retryAfterSeconds"), "rate_limited row").toBe(sendsRetryAfter);
  });
});

describe("docs/MCP.md destructive previews", () => {
  it("grades lnkdrp_delete_project the way the tool grades it", () => {
    const src = SOURCES.get("lnkdrp_delete_project")!;
    const section = docSection("lnkdrp_delete_project");
    // The old rule named the public page and the document count, neither of which is a fact about
    // anyone losing anything - and the confirmation section three hundred lines below already
    // described the traffic rule, so the document contradicted itself.
    expect(src).toContain("severityFromTraffic");
    expect(section).toContain("severityFromTraffic");
    expect(section).not.toMatch(/`severity: "high"` when the public page/);
  });
});

describe("docs/MCP.md set_share_access warnings", () => {
  const src = readFileSync(path.join(TOOLS_DIR, "setShareAccess.ts"), "utf8");
  const ladder = /function warningsForSwitchedOn\([\s\S]*?\n}/.exec(src)![0];
  const section = docSection("lnkdrp_set_share_access");

  it("does not present the ladder as a closed pair", () => {
    // Five branches wore one sentence about links "revoked on their own", and the remedy that
    // sentence named is the one the archived branch says in so many words cannot help.
    expect(section).not.toContain("Two different outcomes");
  });

  for (const remedy of ["lnkdrp_archive_doc", "lnkdrp_update_share_link", "lnkdrp_list_share_links", "expiresAt"]) {
    it(`names ${remedy} when a branch prescribes it`, () => {
      expect(section.includes(remedy), `docs for the ${remedy} branch`).toBe(ladder.includes(remedy));
    });
  }
});

describe("docs/MCP.md project links", () => {
  const src = readFileSync(path.join(TOOLS_DIR, "projectLinks.ts"), "utf8");

  it("does not present Project.shareEnabled as the live answer", () => {
    // The code stopped trusting the stored flag because expiry is not a write; the doc went on
    // asserting the equation as the premise the rest of the section rests on.
    expect(src).toContain("derivable ? anyLive : project.shareEnabled");
    const prose = DOC.slice(DOC.indexOf("### Project links"), DOC.indexOf("#### `lnkdrp_create_project_link`"));
    expect(prose).not.toContain('`Project.shareEnabled` is "at least one link\nis live"');
    expect(prose).toMatch(/denormalised/);
    expect(prose).toMatch(/recomputed only when a link is/);
  });

  it("documents the rename warning on lnkdrp_update_project_link", () => {
    const tool = SOURCES.get("lnkdrp_update_project_link")!;
    const section = docSection("lnkdrp_update_project_link");
    expect(section.includes("rename"), "the duplicate-label half").toBe(tool.includes("duplicateLabelWarning"));
  });
});

describe("docs/MCP.md untrusted text", () => {
  /** Every free-text key the activity feed wraps. The list is the security surface of the feed. */
  const textKeys = (() => {
    const src = readFileSync(path.join(TOOLS_DIR, "discover.ts"), "utf8");
    const block = /const TEXT_KEYS = new Set\(\[([\s\S]*?)\]\);/.exec(src);
    expect(block, "discover.ts has no TEXT_KEYS").toBeTruthy();
    // Entry lines only: the comments inside the set quote `"agents"` and other keys that are not
    // in it.
    return [...block![1].matchAll(/^\s*"([A-Za-z]+)",/gm)].map((m) => m[1]);
  })();

  it("lists every meta key the feed wraps", () => {
    // The doc named seven of fifteen. A reader auditing whether projectName, fileName, tagName or
    // meta.client reach the model bare would have concluded they do.
    const out = outBullet("lnkdrp_get_activity");
    const sentence = /Those keys are([\s\S]*?)—/.exec(out);
    expect(sentence, "no 'Those keys are' list in get_activity's Out bullet").toBeTruthy();
    const listed = [...sentence![1].matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]);
    expect([...listed].sort()).toEqual([...textKeys].sort());
  });

  it("does not claim tag names are never wrapped", () => {
    // They are raw in the tag tools' own rows and wrapped on a feed row; the blanket sentence was
    // false on the half a reader is most likely to be auditing.
    expect(textKeys).toContain("tagName");
    expect(DOC).not.toContain("Tag names are the deliberate exception: they are **not** wrapped.");
  });
});

describe("docs/MCP.md e2e section", () => {
  const expected = /const EXPECTED_TOOLS = \[([\s\S]*?)\] as const;/.exec(E2E_SRC)![1];
  const expectedCount = [...expected.matchAll(/"(lnkdrp_[a-z_]+)"/g)].length;

  it("describes a check that runs both ways over the whole catalogue", () => {
    const registered = new Set(SOURCES.keys());
    expect(expectedCount).toBe(registered.size);
    // The doc told a reader the harness could not catch a missing registration, long after it
    // could, and invited a fix that was already applied.
    expect(DOC).not.toContain("must carry the thirty named tools");
    expect(DOC).not.toMatch(/that is a \*subset\* check/);
  });

  it("does not print a step count that cannot be right", () => {
    // 44 was written down once and the harness has fifty-one steps; a reader comparing a real run
    // against it would take a complete run for a truncated one.
    expect(DOC).not.toMatch(/"steps":\d+/);
  });

  it("describes the password step's actual assertion", () => {
    const step = /await step\("lnkdrp_verify_share_password[\s\S]*?\n {4}\}\);/.exec(E2E_SRC)![0];
    const asserts = /code === "forbidden"/.test(step);
    // The caveat told a maintainer to expect and discount a red password step. That failure can no
    // longer happen, so the paragraph now only teaches someone to wave a real one through.
    expect(asserts, "the harness asserts the refusal").toBe(true);
    const tail = DOC.slice(DOC.lastIndexOf("before reading a red run"));
    expect(tail).toContain("forbidden");
    expect(tail).not.toContain("returns the plaintext");
  });
});
