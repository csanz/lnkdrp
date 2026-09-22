/**
 * `lnkdrp_set_share_access` — change a share link's settings (enabled, download, password,
 * revision history). PATCH /api/docs/:id plus POST share-password as needed, then re-read.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ApiShareLink, DocPatch } from "../api";
import type { ToolContext } from "../context";
import { handleTool, ToolError } from "../errors";
import { fingerprintArgs, IdempotencyStore } from "../idempotency";
import { docIdSchema, SAFETY_TAIL, shareView, withDefaultLinkState } from "./shared";

type ShareViewWithLink = Awaited<ReturnType<typeof withDefaultLinkState>>;

/**
 * Why nothing opened, said by the thing that is actually shut.
 *
 * The first fix here split "some links stayed off" from "nothing opened at all" and then read both
 * answers off `anyLinkActive` / `defaultLinkActive`. Those booleans do not carry a cause: shared.ts
 * computes them as `!doc.isArchived && link.enabled && link.active`, so an archived document and an
 * expired link both collapse into the same false, and the warning went on asserting the one cause
 * it knew about, revocation. Two live examples: a document archived a moment earlier was told
 * "every link on this document had been revoked on its own" while the payload next to it said
 * `isArchived: true` and its only link said `enabled: true`; a default link past its expiry was
 * told it "was turned off on its own" while the same payload said `status: "expired"`. Both then
 * prescribed lnkdrp_update_share_link { enabled: true }, which on an already-enabled link changes
 * nothing and reports success, so the agent tells its human the document is live when it opens for
 * nobody. That is the exact failure the split was written to prevent.
 *
 * So the ladder asks the rows, not the booleans: archiving first, because it overrides every link's
 * own state, then the reason each link carries in `status`. Every branch names a remedy that moves
 * the thing it just blamed.
 */
function warningsForSwitchedOn(view: ShareViewWithLink, links: ApiShareLink[]): string[] {
  if (view.isArchived) {
    return [
      "Sharing was switched on, but this document is archived, so none of its links resolve whatever the switch says. " +
        "Bring it back with lnkdrp_archive_doc archived: false and the links that were live open again; they keep " +
        "their own state while it is archived. lnkdrp_update_share_link cannot help here: it will report a link " +
        "enabled and active while that link still opens for nobody.",
    ];
  }
  if (!view.anyLinkActive) {
    const expired = links.filter((l) => l.enabled && l.status === "expired").length;
    const revoked = links.filter((l) => !l.enabled).length;
    const cause =
      expired > 0 && revoked === 0
        ? "every link on this document has passed its expiry date, and the switch does not move an expiry. Nobody can " +
          "reach it until you give one a later date, or clear it with lnkdrp_update_share_link expiresAt: null."
        : revoked > 0 && expired === 0
          ? "every link on this document had been revoked on its own, and the switch never restores those. Nobody can " +
            "reach it until you enable a specific link with lnkdrp_update_share_link."
          : expired > 0 && revoked > 0
            ? "some of its links were revoked on their own and the rest have expired, and the switch restores neither. " +
              "Read lnkdrp_list_share_links and reopen one with lnkdrp_update_share_link: enabled: true for a revoked " +
              "link, expiresAt for an expired one."
            : "no link on this document is open. Read lnkdrp_list_share_links for the reason each one carries before " +
              "telling the human the document is reachable.";
    return [`Sharing was switched on, but no link opened: ${cause}`];
  }
  if (!view.defaultLinkActive) {
    const status = view.link?.status ?? null;
    if (status === "expired") {
      const expiresAt = view.link?.expiresAt;
      return [
        "Sharing is on and other links are live, but the default link stays shut because its expiry has passed" +
          (expiresAt ? ` (${expiresAt})` : "") +
          ". It is still enabled, so turning it on does nothing: give it a later date, or clear the expiry with " +
          "lnkdrp_update_share_link expiresAt: null.",
      ];
    }
    if (status === "disabled") {
      return [
        "Sharing is on and other links are live, but the default link stays disabled because it was turned off on " +
          "its own. Turn it on with lnkdrp_update_share_link if the human wants that link to open again.",
      ];
    }
    return [
      "Sharing is on and other links are live, but the default link is not open" +
        (status ? ` (status ${status})` : " and the document has no default link row") +
        ". Read lnkdrp_list_share_links for the reason before telling the human that this document's own link works.",
    ];
  }
  return [];
}

export const setShareAccessInputShape = {
  idempotencyKey: z.string().min(1).max(128).describe("Caller-chosen key (1-128 chars); a retry with the same key returns the stored result."),
  docId: docIdSchema,
  shareEnabled: z
    .boolean()
    .optional()
    .describe(
      "The document-wide switch: false turns off every share link on the document at once; true turns back on the links " +
        "that switch turned off. It restores nothing else: a link disabled on its own with lnkdrp_update_share_link " +
        "stays off, an expired link stays expired, and while the document is archived no link resolves at all.",
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
        /**
         * Read the links here and hand them down.
         *
         * `withDefaultLinkState` reads them anyway, and the warning below has to name which link is
         * shut and why, which only the rows say. Reading them once keeps the reason and the
         * booleans describing the same moment, the way get_share already does.
         */
        const links = await ctx.api.listShareLinks(args.docId).catch(() => []);
        const view = await withDefaultLinkState(ctx.api, doc, shareView(ctx.api, doc), links);
        /**
         * The switch only restores links it disabled itself, so asking for sharing can leave a link
         * shut for a reason of its own. `warningsForSwitchedOn` says which reason.
         */
        const askedOn = args.shareEnabled === true;
        const warnings = askedOn ? warningsForSwitchedOn(view, links) : [];
        return { ...view, warnings };
      }, { fingerprint: fingerprintArgs(args) });
      return value;
    }),
  );
}
