/**
 * `lnkdrp_set_doc_visibility` - keep a document inside its data room, or list it in the workspace again.
 *
 * A document with visibility "project" is listed only inside its primary project: it leaves the
 * workspace's document list (`lnkdrp_list_docs`) and cannot be added to a second project (that
 * answers `CONTAINED`). Nothing about its links changes: the direct share link still opens and
 * `lnkdrp_get_share` / `lnkdrp_get_share_stats` still answer for it. Containment needs a home, so a
 * document in no project cannot be contained (`VISIBILITY_NEEDS_PROJECT`, mapped to `validation`
 * with the fix named). See docs/prds/lnkdrp-project-home.md, decisions 3, 7 and 8.
 *
 * Wraps `PATCH /api/docs/:id { visibility }` (`ApiClient.setDocVisibility`).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ToolContext } from "../context";
import { handleTool } from "../errors";
import { docIdSchema, SAFETY_TAIL } from "./shared";

export const setDocVisibilityInputShape = {
  docId: docIdSchema.describe("Document id (24 hex chars), from lnkdrp_list_docs or lnkdrp_get_project."),
  visibility: z
    .enum(["workspace", "project"])
    .describe('"project" keeps the document inside its primary data room only; "workspace" lists it in the workspace again.'),
};

/** Register `lnkdrp_set_doc_visibility`. */
export function registerSetDocVisibilityTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_set_doc_visibility",
    {
      title: "Set document visibility",
      description:
        "Keep a document inside its data room (visibility \"project\") or list it in the workspace again (\"workspace\"). " +
        "A contained document appears only inside its primary project, is left out of lnkdrp_list_docs and cannot be added " +
        "to a second project, while its direct share link and lnkdrp_get_share keep working. The document must already be " +
        "in a project (add it with lnkdrp_add_docs_to_project first; otherwise this is a validation error, code " +
        "VISIBILITY_NEEDS_PROJECT). Safe to repeat: setting the state it is already in changes nothing. Returns docId, " +
        "visibility and primaryProjectId. " +
        SAFETY_TAIL,
      inputSchema: setDocVisibilityInputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async (args) => {
      // Lower-cased at the door, like star_docs: the id regex accepts either case and the API echoes
      // ids back lower-cased, so the id in the result matches the one lnkdrp_list_docs would show.
      const docId = args.docId.toLowerCase();
      const doc = await ctx.api.setDocVisibility(docId, args.visibility);
      return { docId: doc.id, visibility: doc.visibility, primaryProjectId: doc.primaryProjectId };
    }),
  );
}
