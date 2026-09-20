/**
 * `lnkdrp_find_share_link` — find a share link by name, across the whole workspace.
 *
 * mt_9ceLy7DqEr, hit live: "give me the a16z link of the coffee doc" only worked because the
 * workspace had few enough documents that `lnkdrp_list_docs("coffee")` found the right one by
 * title, and few enough links on it to read "Inesto / a16z" off `lnkdrp_list_share_links` by eye.
 * Neither tool searches by the name a human actually gives a link — that field is `label`
 * (or `audience`), never the document's title and never the random public `shareId`. This is the
 * "I don't know which document it's on" search; `lnkdrp_list_share_links`'s own `query` parameter
 * is the same search once the document is already known.
 *
 * Backed by a MongoDB text index on `ShareLink.label`/`audience` (`GET /api/share-links`), not a
 * regex scan — ranked by relevance and fast regardless of workspace size, at the cost of matching
 * whole words only: "a16z" or "Inesto" match, "nest" does not. That trade is stated up front in the
 * tool description rather than discovered by a query that quietly returns nothing.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ToolContext } from "../context";
import { handleTool } from "../errors";
import { SAFETY_TAIL } from "./shared";
import { untrustedOrNull, UNTRUSTED_LIMITS } from "../untrusted";

export const findShareLinkInputShape = {
  query: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe("Name to search for, e.g. \"a16z\" or \"Sequoia\". Matches a link's label or audience. Whole words, not substrings."),
  limit: z.number().int().min(1).max(50).default(20).describe("Max results, 1-50, default 20."),
};

/** Register `lnkdrp_find_share_link`. */
export function registerFindShareLinkTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_find_share_link",
    {
      title: "Find a share link by name",
      description:
        "Search every share link in the workspace by label or audience - the private name a human gave it (\"Sequoia\", " +
        "\"Inesto / a16z\"), not the document's title and not the link's random public shareId (neither of those are " +
        "searched here). Use this when you know the link's name but not which document it is on; once you know the " +
        "document, lnkdrp_list_share_links's own query parameter does the same search scoped to it. Backed by a MongoDB " +
        "text index: ranked by relevance, matches whole words only - searching \"a16z\" or \"Inesto\" matches, a partial " +
        "word like \"nest\" does not. Archived and deleted documents' links are excluded. Hits cover both kinds of link: " +
        "kind 'doc' carries docId/docTitle and a /s/ URL, kind 'project' carries projectId/projectName, a /p/ URL and a " +
        "null docId (use the project tools for it - lnkdrp_update_share_link and lnkdrp_delete_share_link are document " +
        "links only). Each hit carries status " +
        "(active|disabled|expired), enabled and expiresAt, so you can say whether a found link still opens. Returns [] when nothing matches, " +
        "never an error. " +
        SAFETY_TAIL,
      inputSchema: findShareLinkInputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async (args) => {
      /**
       * The index is OR; the question is AND.
       *
       * `GET /api/share-links` runs a Mongo text search, which returns a row when *any* term hits.
       * So "Sequoia diligence" came back with a link matching only "Sequoia" and another matching
       * only a word in an unrelated label, ranked as though both were answers — and a query of two
       * specific words is a caller narrowing down, not widening out.
       *
       * Rather than change what the index does, the hits are narrowed here to those carrying every
       * term. When nothing matches all of them the OR results are returned anyway, with a warning
       * that says so: an empty answer to "find the Sequoia diligence link" is less useful than a
       * near miss the human can recognise, as long as it is labelled a near miss.
       */
      const raw = await ctx.api.findShareLinks(args.query, Math.min((args.limit ?? 10) * 4, 50));
      const terms = args.query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
      const haystack = (h: (typeof raw)[number]) =>
        [h.label, h.audience, h.docTitle, h.projectName, h.shareId].filter(Boolean).join(" ").toLowerCase();
      const all = terms.length > 1 ? raw.filter((h) => terms.every((t) => haystack(h).includes(t))) : raw;
      const narrowed = all.length > 0;
      const hits = (narrowed ? all : raw).slice(0, args.limit ?? 10);
      return {
        query: args.query,
        ...(terms.length > 1 && !narrowed && hits.length
          ? {
              warnings: [
                `No link matches every word of "${args.query}". These match at least one, ranked by relevance. Check ` +
                  "the label and audience before using one.",
              ],
            }
          : {}),
        links: hits.map((h) => ({
          // A project link opens a data room at /p/<shareId>, not a document at /s/<shareId>, and
          // has no docId: handing back the /s/ form gave the human a URL that resolves to nothing.
          kind: h.kind,
          docId: h.docId,
          // Wrapped like every other document-derived string in the tool surface. This was the one
          // place a PDF's own title reached an agent bare: a title is attacker-supplied content,
          // since anyone who can get a file shared into a workspace chooses it.
          docTitle: untrustedOrNull(h.docTitle, "document", UNTRUSTED_LIMITS.title),
          docShareId: h.docShareId,
          ...(h.kind === "project"
            ? { projectId: h.projectId, projectName: untrustedOrNull(h.projectName, "document", UNTRUSTED_LIMITS.short) }
            : {}),
          linkId: h.linkId,
          shareId: h.shareId,
          shareUrl: h.kind === "project" ? ctx.api.projectPublicUrl(h.shareId) : ctx.api.shareUrl(h.shareId),
          label: h.label,
          audience: h.audience,
          isDefault: h.isDefault,
          enabled: h.enabled,
          expiresAt: h.expiresAt,
          status: h.status,
        })),
      };
    }),
  );
}
