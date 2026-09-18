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

export const findShareLinkInputShape = {
  query: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe("Name to search for, e.g. \"a16z\" or \"Sequoia\" — matches a link's label or audience. Whole words, not substrings."),
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
      const hits = await ctx.api.findShareLinks(args.query, args.limit);
      return {
        query: args.query,
        links: hits.map((h) => ({
          // A project link opens a data room at /p/<shareId>, not a document at /s/<shareId>, and
          // has no docId: handing back the /s/ form gave the human a URL that resolves to nothing.
          kind: h.kind,
          docId: h.docId,
          docTitle: h.docTitle,
          docShareId: h.docShareId,
          ...(h.kind === "project" ? { projectId: h.projectId, projectName: h.projectName } : {}),
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
