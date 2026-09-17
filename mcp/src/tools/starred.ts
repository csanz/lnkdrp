/**
 * `lnkdrp_star_docs` and `lnkdrp_list_starred` — the sidebar's starred documents.
 *
 * Stars belong to a person, not the workspace: they are the API key creator's own shortlist, shown
 * at the top of their sidebar. Starring is not sharing and changes nothing a recipient sees.
 *
 * `POST /api/starred` toggles for the web button; these tools always pass `starred` so a repeated
 * call is safe (starring an already starred document is a no-op, never an unstar).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ApiStarredDoc } from "../api";
import type { ToolContext } from "../context";
import { handleTool, isToolError } from "../errors";
import { UNTRUSTED_LIMITS, untrustedOrNull } from "../untrusted";
import { docIdSchema, SAFETY_TAIL } from "./shared";

export const starDocsInputShape = {
  docIds: z.array(docIdSchema).min(1).max(50).describe("Documents to star or unstar (1-50)."),
  starred: z.boolean().default(true).describe("true to star (default), false to unstar."),
};

const starredView = (docs: ApiStarredDoc[]) =>
  docs.map((d) => ({ docId: d.id, title: untrustedOrNull(d.title, "document", UNTRUSTED_LIMITS.title), starredAt: d.starredAt }));

/** Register `lnkdrp_star_docs`. */
export function registerStarDocsTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_star_docs",
    {
      title: "Star documents",
      description:
        "Star (or with starred: false, unstar) up to 50 documents so they sit at the top of the key owner's sidebar. Stars " +
        "are personal to the person who created the API key, not shared with the workspace, and change nothing recipients " +
        "see. Safe to repeat: a document already in the requested state is reported in unchanged, never flipped. Returns " +
        "changed, unchanged and notFound (unknown, deleted or archived documents), plus the full starred list afterwards. " +
        SAFETY_TAIL,
      inputSchema: starDocsInputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async (args) => {
      const ids = [...new Set(args.docIds)];
      let current = await ctx.api.listStarred();
      const changed: string[] = [];
      const unchanged: string[] = [];
      const notFound: string[] = [];
      for (const docId of ids) {
        const before = current.some((d) => d.id === docId);
        // Already starred needs no call. Anything else goes to the API even when it looks like a
        // no-op, because only the API can say an unstarred id is not a visible document.
        if (args.starred && before) {
          unchanged.push(docId);
          continue;
        }
        try {
          current = await ctx.api.setStarred(docId, args.starred);
          (current.some((d) => d.id === docId) === before ? unchanged : changed).push(docId);
        } catch (err) {
          if (isToolError(err) && err.code === "not_found") notFound.push(docId);
          else throw err;
        }
      }
      return { starred: args.starred, changed, unchanged, ...(notFound.length ? { notFound } : {}), starredDocs: starredView(current) };
    }),
  );
}

/** Register `lnkdrp_list_starred`. */
export function registerListStarredTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_list_starred",
    {
      title: "List starred documents",
      description:
        "The key owner's starred documents in this workspace, in their sidebar order. Deleted and archived documents are " +
        "left out (their stars come back if the document does). " +
        SAFETY_TAIL,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async () => {
      const docs = await ctx.api.listStarred();
      return { total: docs.length, starredDocs: starredView(docs) };
    }),
  );
}
