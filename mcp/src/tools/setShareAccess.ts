/**
 * `lnkdrp_set_share_access` — change a share link's settings (enabled, download, password,
 * revision history). PATCH /api/docs/:id plus POST share-password as needed, then re-read.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { DocPatch } from "../api";
import type { ToolContext } from "../context";
import { handleTool, ToolError } from "../errors";
import { fingerprintArgs, IdempotencyStore } from "../idempotency";
import { docIdSchema, SAFETY_TAIL, shareView, withDefaultLinkState } from "./shared";

export const setShareAccessInputShape = {
  idempotencyKey: z.string().min(1).max(128).describe("Caller-chosen key (1-128 chars); a retry with the same key returns the stored result."),
  docId: docIdSchema,
  shareEnabled: z
    .boolean()
    .optional()
    .describe(
      "The document-wide switch: false turns off every share link on the document at once; true turns back on the links " +
        "that switch turned off (a link disabled on its own with lnkdrp_update_share_link stays off).",
    ),
  allowDownload: z.boolean().optional().describe("Let viewers of the default link download the PDF (other links keep their own setting)."),
  password: z
    .string()
    .min(1)
    .max(128)
    .nullable()
    .optional()
    .describe(
      "Set the default link's password (1-128 chars) or null to remove it. " +
        "Use exactly the password the human gave you, whatever its length - a one-character password is allowed. Never substitute a longer one of your own: they will type theirs at the gate and be locked out. Tell them the password you set; the owner can also reveal it later in the link's settings.",
    ),
  allowRevisionHistory: z.boolean().optional().describe("Let viewers see earlier versions (Pro feature)."),
};

/** Register `lnkdrp_set_share_access`. */
export function registerSetShareAccessTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_set_share_access",
    {
      title: "Set share access",
      description:
        "Update a document's sharing: shareEnabled switches every link on the document off or back on, while allowDownload, " +
        "password (string to set, null to remove) and allowRevisionHistory apply to the default link only - use " +
        "lnkdrp_update_share_link for any other link. " +
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
        const doc = await ctx.api.getDoc(args.docId);
        const view = await withDefaultLinkState(ctx.api, doc, shareView(ctx.api, doc));
        /**
         * Two different outcomes wore one sentence.
         *
         * The switch only restores links it disabled itself, so asking for sharing can leave
         * individually revoked links off — and the old warning said "Sharing is on, but the default
         * link stays disabled" in both the case where that is true and the case where *every* link
         * was revoked and nothing opened at all. The second reading is the dangerous one: an agent
         * told sharing is on reports to its human that the document is live when it opens for
         * nobody.
         */
        const askedOn = args.shareEnabled === true;
        const warnings = !askedOn
          ? []
          : !view.anyLinkActive
            ? [
                "Sharing was switched on, but no link opened: every link on this document had been revoked on its own, " +
                  "and the switch never restores those. Nobody can reach it until you enable a specific link with " +
                  "lnkdrp_update_share_link.",
              ]
            : !view.defaultLinkActive
              ? [
                  "Sharing is on and other links are live, but the default link stays disabled because it was turned " +
                    "off on its own. Turn it on with lnkdrp_update_share_link if the human wants that link to open again.",
                ]
              : [];
        return { ...view, warnings };
      }, { fingerprint: fingerprintArgs(args) });
      return value;
    }),
  );
}
