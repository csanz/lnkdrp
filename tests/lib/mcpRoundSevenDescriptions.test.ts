/**
 * A tool description that contradicts its own tool is the most expensive bug on this surface.
 *
 * An agent cannot check an answer against anything: it reads the description, calls the tool, and
 * repeats the result to a human as fact. Four rounds of fixes added result fields and narrowed
 * behaviours, and each round the descriptions were edited by hand afterwards, which is how these
 * three drifted:
 *
 * - `lnkdrp_get_share_stats` said `downloadsEnabled` answers "any live link allows it". The route
 *   only answers that without `?shareId=`; with one it is that link's own `allowDownload`, and the
 *   same description recommends passing docId + shareId together to read a non-default link.
 * - `lnkdrp_create_share_link` and `lnkdrp_create_project_link` described every refusal they can
 *   meet as a plan decision, so "never plan-capped" and "Pro" both read as "no ceiling". There is
 *   one, at 50 links, and it comes back as `validation` + `too_many_links`, which is permanent.
 * - Four tools return `replayed: true` so a caller can tell a retry from a second write. Only
 *   `lnkdrp_set_share_access` ever named the field, so on the other three it was emitted into a
 *   contract nobody had been told about.
 *
 * Every check below derives its fact from the code rather than restating it: the live tool list
 * off `createMcpServer`, the cap constants off `src/lib/share`, the per-link branch off the
 * shareviews route. Change the behaviour and the assertion moves with it, so a description that
 * stops matching fails here without anyone having to remember this file.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";

import { createMcpServer } from "../../mcp/src/server";
import type { ToolContext } from "../../mcp/src/context";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

type ToolInfo = { name: string; description: string; inputSchema: Record<string, unknown> };

/**
 * The tools as a client receives them.
 *
 * Reading the source files instead would test the strings next to the code that happens to be in
 * the same file, and two of these tools keep their input shape in a module-level const outside the
 * registration. `tools/list` is the only place the description and the schema a client actually
 * gets are the same object.
 */
const tools = new Map<string, ToolInfo>();

beforeAll(async () => {
  const ctx = {
    config: { featureRequestsEnabled: false },
    api: {},
    whoami: () => ({ orgId: "o1", orgName: "Personal", isPersonalOrg: true, plan: "pro" }),
    setWhoami: () => {},
    idempotency: {},
  } as unknown as ToolContext;
  const server = createMcpServer(ctx);
  const client = new Client({ name: "round-seven", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  for (const t of (await client.listTools()).tools) {
    tools.set(t.name, { name: t.name, description: t.description ?? "", inputSchema: t.inputSchema as Record<string, unknown> });
  }
});

/** A tool's description plus every field description in its input schema: everything an agent reads. */
function surface(name: string): string {
  const tool = tools.get(name);
  expect(tool, `${name} is not registered`).toBeTruthy();
  return `${tool!.description}\n${JSON.stringify(tool!.inputSchema)}`;
}

describe("lnkdrp_get_share_stats: downloadsEnabled says which scope it is answering", () => {
  const ROUTE = read("src/app/api/docs/[docId]/shareviews/route.ts");

  /**
   * The route's own branch, read out of the route. `link` is set only by `?shareId=`, which is the
   * argument shape the tool's description recommends for reading one non-default link.
   */
  const perLinkBranch = /const downloadsEnabled = link\s*\n?\s*\?\s*Boolean\(link\.allowDownload\)/.test(ROUTE);
  /**
   * Matched on the field names rather than on the route's line breaks. The previous form spelled
   * out every newline and indent of the query, so reformatting the route - not changing it - would
   * have failed this test and taught the next reader to loosen the assertion rather than look.
   */
  const docWideBranch = ["ShareLinkModel.exists(", "archivedAt: null", "enabled: true", "allowDownload: true"].every((f) => ROUTE.includes(f));
  /**
   * The half the description used to deny. The route ORs the document's legacy flag in after the
   * link lookup, so "any live link allows it" is not the whole answer: a document with no
   * download-allowing link still reports true when `shareAllowPdfDownload` is set on the row.
   */
  const legacyFallback = /\|\|\s*\n?\s*Boolean\(\(doc as unknown as \{ shareAllowPdfDownload\?: unknown \}\)\.shareAllowPdfDownload\)/.test(ROUTE);

  it("still has the two branches this description has to tell apart", () => {
    // If either disappears the sentence below is wrong again, in the other direction.
    expect(perLinkBranch, "the ?shareId= branch of downloadsEnabled").toBe(true);
    expect(docWideBranch, "the document-wide branch of downloadsEnabled").toBe(true);
  });

  it("does not offer 'any live link allows it' as the whole answer", () => {
    const description = tools.get("lnkdrp_get_share_stats")!.description;
    // Two ways this sentence has been wrong. It was unqualified, so an agent reading it off a
    // perLink call reported one link's allowDownload as a fact about the document; and then it
    // named the docId scope but denied the legacy flag the route actually ORs in.
    const claimsDocWide = description.includes("any live link allows it");
    expect(claimsDocWide, "the document-wide claim is still worth making").toBe(docWideBranch);
    if (!claimsDocWide) return;
    expect(description, "the claim has to name the call it holds for").toMatch(/docId alone/);
    expect(
      /legacy shareAllowPdfDownload|or the document carries/.test(description),
      "the route ORs doc.shareAllowPdfDownload in, so the description cannot present the link lookup as the whole answer",
    ).toBe(legacyFallback);
  });

  it("does not tell the reader the legacy flag is excluded", () => {
    const description = tools.get("lnkdrp_get_share_stats")!.description;
    // It said "deliberately not get_share's shareAllowPdfDownload" while the route ORed exactly
    // that in. A reader who believed it would trust a true here as proof of a live link.
    expect(/deliberately not .{0,40}shareAllowPdfDownload/.test(description)).toBe(false);
  });

  it("names the per-link meaning whenever the route has one", () => {
    const description = tools.get("lnkdrp_get_share_stats")!.description;
    // Case-insensitive: the sentence has begun a paragraph before now, and a capital W is not a
    // contract change.
    expect(/with a shareId it is that one link's allowDownload/i.test(description), "the perLink half").toBe(perLinkBranch);
  });

  it("does not leave the unqualified claim standing in docs/MCP.md", () => {
    // The reference carried the same sentence, and it is the one a client author builds against.
    const bullet = /- \*\*`downloadsEnabled` is the other reading[\s\S]*?\n(?=- \*\*)/.exec(read("docs/MCP.md"));
    expect(bullet, "no downloadsEnabled bullet in docs/MCP.md").toBeTruthy();
    expect(/Boolean\(link\.allowDownload\)/.test(bullet![0]), "the perLink half").toBe(perLinkBranch);
    // And the doc-wide half has to admit the OR, for the same reason the tool description does.
    expect(/shareAllowPdfDownload/.test(bullet![0]), "the legacy fallback").toBe(legacyFallback);
    expect(/deliberately not/.test(bullet![0]), "the reference must not deny the fallback").toBe(false);
  });
});

describe("lnkdrp_get_share_stats: archived documents are not served by shareId", () => {
  const SHARED = read("mcp/src/tools/shared.ts");
  const STATS = read("mcp/src/tools/getShareStats.ts");

  /**
   * `resolveDoc` refuses an archived document by shareId, and this tool calls it exactly when no
   * docId was given. Both halves are read here, because the description's archived paragraph is
   * only true on the branch that does not go through `resolveDoc`.
   */
  const resolveRefusesArchived = /Archived documents are not served by[\s\S]{0,40}shareId/.test(SHARED);
  const statsResolvesByShareId = /resolveDoc\(ctx\.api, \{ shareId: args\.shareId \}\)/.test(STATS);

  it("says so, rather than promising history on either argument", () => {
    const description = tools.get("lnkdrp_get_share_stats")!.description;
    const mustWarn = resolveRefusesArchived && statsResolvesByShareId;
    // An agent holding only a slug read "an archived document still reports its history", got a
    // not_found, and had no way to tell a revoked slug from an archived document.
    expect(/archived document is not served by shareId/.test(description), "the docId-only caveat").toBe(mustWarn);
  });
});

describe("link ceilings reach an agent before it plans against them", () => {
  /** The two runaway guards, read from the modules that enforce them. */
  const perDoc = Number(/export const SHARE_LINKS_PER_DOC_MAX = (\d+);/.exec(read("src/lib/share/links.ts"))![1]);
  const perProject = Number(/export const SHARE_LINKS_PER_PROJECT_MAX = (\d+);/.exec(read("src/lib/share/projectLinks.ts"))![1]);

  /** The mapper turns the cap into a permanent `validation`, not a retryable `upstream`. */
  const capIsValidation = /if \(bodyCode === "too_many_links"\)/.test(read("mcp/src/errors.ts"));

  it("lnkdrp_create_share_link names the number and the code", () => {
    const text = surface("lnkdrp_create_share_link");
    // It also says "links are never plan-capped ... one per investor or counterparty", which is
    // true and, on its own, an invitation to keep going past the ceiling.
    expect(text).toContain("never plan-capped");
    expect(text, `the per-document cap is ${perDoc}`).toContain(`at most ${perDoc} links`);
    expect(text.includes("too_many_links"), "the code an agent branches on").toBe(capIsValidation);
  });

  it("lnkdrp_create_project_link names the number and the code", () => {
    const text = surface("lnkdrp_create_project_link");
    // Every other refusal this tool describes is a plan decision, so "Pro" read as "unlimited".
    expect(text).toContain("Pro feature");
    expect(text, `the per-project cap is ${perProject}`).toContain(`at most ${perProject} links`);
    expect(text.includes("too_many_links"), "the code an agent branches on").toBe(capIsValidation);
  });
});

describe("replayed is named by every tool that emits it", () => {
  /**
   * Which tools carry the flag, read off their sources rather than listed here, so a fifth write
   * tool given an idempotencyKey is covered the day it lands.
   */
  const EMITTERS: Array<{ tool: string; file: string }> = [
    { tool: "lnkdrp_share_pdf", file: "mcp/src/tools/sharePdf.ts" },
    { tool: "lnkdrp_replace_pdf", file: "mcp/src/tools/replacePdf.ts" },
    { tool: "lnkdrp_create_project", file: "mcp/src/tools/projects.ts" },
    { tool: "lnkdrp_set_share_access", file: "mcp/src/tools/setShareAccess.ts" },
  ];

  for (const { tool, file } of EMITTERS) {
    it(`${tool}`, () => {
      const emits = /replayed: true/.test(read(file));
      // A field an agent must branch on to avoid reporting two uploads is not optional prose: the
      // whole point of the flag is that the caller knows to look for it.
      expect(/\breplayed\b/.test(surface(tool)), `${tool} emits replayed: ${emits}`).toBe(emits);
    });
  }

  it("covers every tool that takes an idempotencyKey", () => {
    // The list above is hand-written; this is the check that it is not short. Any tool with the
    // argument replays, and a replay the caller cannot see is the bug in the first place.
    const takesKey = [...tools.values()]
      .filter((t) => JSON.stringify(t.inputSchema).includes('"idempotencyKey"'))
      .map((t) => t.name);
    expect([...takesKey].sort()).toEqual(EMITTERS.map((e) => e.tool).sort());
  });
});

describe("lnkdrp_whoami: costs is a price list, not a prediction", () => {
  const PROCESS = read("src/app/api/uploads/[uploadId]/process/route.ts");

  /**
   * The automatic summary is pinned to basic in the route, whatever the workspace's review tier
   * says. `costs` presents three tiers per action, so an agent budgeting a replacement against a
   * workspace on `review: standard` predicts 2 for the summary and is charged 1. Measured live on
   * 2026-09-22: seven replacements, six credits each, which is 1 + compare-at-standard(5).
   */
  const summaryPinnedToBasic = /const summaryTier = "basic" as const;/.test(PROCESS);

  it("still pins the automatic summary to basic", () => {
    expect(summaryPinnedToBasic, "the route no longer hardcodes the summary tier").toBe(true);
  });

  it("says so, rather than leaving costs.summary to be read as a choice", () => {
    const description = tools.get("lnkdrp_whoami")!.description;
    expect(
      /always billed at basic/.test(description),
      "whoami must say the automatic summary ignores the review tier",
    ).toBe(summaryPinnedToBasic);
  });

  it("names the identical-replacement case, which costs nothing at all", () => {
    // The other half of the same question: an owner watching credits not move after a replacement
    // is usually looking at a re-send, not a broken counter.
    const description = tools.get("lnkdrp_whoami")!.description;
    expect(/identical costs nothing|unchangedFromPrevious/.test(description)).toBe(true);
    // And the route really does skip it, so the claim is not aspirational.
    expect(/const nothingChanged =/.test(PROCESS)).toBe(true);
  });
});
