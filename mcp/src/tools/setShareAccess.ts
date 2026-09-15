/**
 * `lnkdrp_set_share_access` — change a share link's settings (enabled, download, password,
 * revision history). PATCH /api/docs/:id plus POST share-password as needed, then re-read.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { DocPatch } from "../api";
import type { ToolContext } from "../context";
import { handleTool, ToolError } from "../errors";
import { IdempotencyStore } from "../idempotency";
import { docIdSchema, SAFETY_TAIL, shareView } from "./shared";

export const setShareAccessInputShape = {
  idempotencyKey: z.string().min(1).max(128).describe("Caller-chosen key (1-128 chars); a retry with the same key returns the stored result."),
  docId: docIdSchema,
  shareEnabled: z.boolean().optional().describe("Turn the public share link on or off."),
  allowDownload: z.boolean().optional().describe("Let viewers download the PDF."),
  password: z
    .string()
    .min(8)
    .max(128)
    .nullable()
    .optional()
    .describe("Set a share password (8-128 chars) or null to remove it."),
  allowRevisionHistory: z.boolean().optional().describe("Let viewers see earlier versions (Pro feature)."),
};

/** Register `lnkdrp_set_share_access`. */
export function registerSetShareAccessTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_set_share_access",
    {
      title: "Set share access",
      description:
        "Update a share link: shareEnabled, allowDownload, password (string to set, null to remove), allowRevisionHistory. " +
        "At least one setting is required. Returns the same shape as lnkdrp_get_share. Turning sharing on at the Free plan's " +
        "shared-document cap, or enabling revision history on Free, fails with code plan_limit carrying an upgrade link and " +
        "a list of what is still possible on the current plan. " +
        SAFETY_TAIL,
      inputSchema: setShareAccessInputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async (args) => {
      const patch: DocPatch = {};
      if (typeof args.shareEnabled === "boolean") patch.shareEnabled = args.shareEnabled;
      if (typeof args.allowDownload === "boolean") patch.shareAllowPdfDownload = args.allowDownload;
      if (typeof args.allowRevisionHistory === "boolean") patch.shareAllowRevisionHistory = args.allowRevisionHistory;
      const wantsPassword = args.password !== undefined;
      if (Object.keys(patch).length === 0 && !wantsPassword) {
        throw new ToolError("validation", "Pass at least one of shareEnabled, allowDownload, password, allowRevisionHistory.");
      }

      const orgId = ctx.whoami().orgId;
      const { value } = await ctx.idempotency.run(IdempotencyStore.key(orgId, "set_share_access", args.idempotencyKey), async () => {
        if (Object.keys(patch).length > 0) await ctx.api.patchDoc(args.docId, patch);
        if (wantsPassword) await ctx.api.setSharePassword(args.docId, args.password ?? null);
        return shareView(ctx.api, await ctx.api.getDoc(args.docId));
      });
      return value;
    }),
  );
}
