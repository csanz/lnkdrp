/**
 * `lnkdrp_archive_doc` and `lnkdrp_delete_doc` — the two document operations the MCP lacked.
 *
 * The app has always had both, and they are different things:
 *
 * - **Archive** (`PATCH /api/docs/:id { isArchived }`) is soft and reversible. Every link on the
 *   document stops resolving, the document leaves the Free plan's shared-document count, and its
 *   analytics are kept. It is literally the third alternative `lnkdrp_share_pdf`'s own `plan_limit`
 *   error offers — "archive a document that is finished" — which until now no tool could do. The
 *   same tool un-archives (`archived: false`), which re-enters the cap check.
 * - **Delete** (`DELETE /api/docs/:id`) sets `isDeleted` and is permanent from the owner's side.
 *   Every link stops resolving and the document disappears from the app.
 *
 * Both confirm with the human before acting (see `../confirm.ts`). Archive is reversible but still
 * gated: it takes every link on the document down at once, which is a large blast radius for an
 * agent to trigger silently even if a person can undo it later.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { requireHumanConfirmation, severityFromTraffic } from "../confirm";
import type { ToolContext } from "../context";
import { handleTool, ToolError } from "../errors";
import { docIdSchema, SAFETY_TAIL } from "./shared";

const confirmSchema = z
  .boolean()
  .optional()
  .describe(
    "Only for clients that cannot show the user a confirmation prompt. Set to true ONLY after you have shown the user what will happen and they have explicitly said yes in conversation. Never set it pre-emptively.",
  );

/** Everything a person needs to weigh before a document-level action, from two reads. */
async function describeDocument(ctx: ToolContext, docId: string) {
  const [doc, links] = await Promise.all([ctx.api.getDoc(docId), ctx.api.listShareLinks(docId)]);
  const live = links.filter((l) => l.active);
  const recipientViews = links.reduce((a, l) => a + l.viewCount, 0);
  const downloads = links.reduce((a, l) => a + l.downloadCount, 0);
  const lastViewed = links.map((l) => l.lastViewedAt).filter((v): v is string => Boolean(v)).sort().at(-1) ?? null;
  return { doc, links, live, recipientViews, downloads, lastViewed };
}

export function registerArchiveDocTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_archive_doc",
    {
      title: "Archive or unarchive document",
      description:
        "Archive a document (archived: true) or bring it back (archived: false). Archiving is reversible: every share link on " +
        "the document stops resolving, the document stops counting toward the Free plan's shared-document cap, and all analytics " +
        "are kept. This is the right way to free a slot without losing anything - the alternative lnkdrp_share_pdf's plan_limit " +
        "error points to. Unarchiving re-checks the cap and may fail with plan_limit on Free. " +
        "DESTRUCTIVE when archiving: it takes every link down at once, so this tool confirms with the human first. If the " +
        "client supports it, the user is shown the document, its links and traffic, and a yes/no prompt. If not, the call fails " +
        "with requiresConfirmation and a preview in details - show it to the user, ask, and call again with confirm: true only " +
        "if they say yes. Unarchiving needs no confirmation. " +
        SAFETY_TAIL,
      inputSchema: { docId: docIdSchema, archived: z.boolean().describe("true to archive, false to bring the document back."), confirm: confirmSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async (args) => {
      const { doc, live, recipientViews, downloads, lastViewed } = await describeDocument(ctx, args.docId);
      if (args.archived && doc.isArchived) return { ok: true, docId: doc.id, isArchived: true, unchanged: true };
      if (!args.archived && !doc.isArchived) return { ok: true, docId: doc.id, isArchived: false, unchanged: true };

      if (args.archived) {
        await requireHumanConfirmation(
          server,
          {
            headline: `Archive "${doc.title ?? "this document"}"`,
            facts: [
              `${live.length} live link${live.length === 1 ? "" : "s"} will stop resolving at once`,
              recipientViews > 0
                ? `Opened by ${recipientViews} recipient${recipientViews === 1 ? "" : "s"} across all links${lastViewed ? `, most recently ${lastViewed.slice(0, 10)}` : ""}`
                : "Never opened by a recipient",
              downloads > 0 ? `Downloaded ${downloads} time${downloads === 1 ? "" : "s"}` : "Never downloaded",
              "Frees one shared-document slot on the Free plan",
              "All analytics are kept; unarchive any time to bring every link back",
            ],
            severity: severityFromTraffic({ recipientViews, activeLinks: live.length }),
            reversible: true,
          },
          args,
        );
      }

      const { doc: updated, planWarning } = await ctx.api.patchDoc(args.docId, { isArchived: args.archived });
      return {
        ok: true,
        docId: updated.id,
        isArchived: updated.isArchived,
        linksAffected: live.length,
        ...(planWarning ? { planWarning } : {}),
      };
    }),
  );
}

export function registerDeleteDocTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_delete_doc",
    {
      title: "Delete document",
      description:
        "Delete a document permanently. Every share link on it stops resolving and it disappears from the workspace; this " +
        "cannot be undone from the app. If the goal is to free a Free-plan slot or retire a document while keeping its history, " +
        "use lnkdrp_archive_doc instead - it is reversible and keeps analytics. " +
        "DESTRUCTIVE: this tool confirms with the human before acting. If the client supports it, the user is shown the " +
        "document, its links and traffic, and a yes/no prompt directly. If not, the call fails with requiresConfirmation and a " +
        "preview in details - show that preview to the user, ask them, and call again with confirm: true only if they say yes. " +
        "A preview with severity 'high' means recipients have opened this document; do not confirm that on your own judgement. " +
        SAFETY_TAIL,
      inputSchema: { docId: docIdSchema, confirm: confirmSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async (args) => {
      const { doc, links, live, recipientViews, downloads, lastViewed } = await describeDocument(ctx, args.docId);
      if (doc.status === "preparing") {
        throw new ToolError("validation", "The document is still being processed; wait for status ready or failed before deleting it.");
      }
      await requireHumanConfirmation(
        server,
        {
          headline: `Permanently delete "${doc.title ?? "this document"}"`,
          facts: [
            `${links.length} share link${links.length === 1 ? "" : "s"} (${live.length} live) will stop resolving`,
            recipientViews > 0
              ? `Opened by ${recipientViews} recipient${recipientViews === 1 ? "" : "s"} across all links${lastViewed ? `, most recently ${lastViewed.slice(0, 10)}` : ""}`
              : "Never opened by a recipient",
            downloads > 0 ? `Downloaded ${downloads} time${downloads === 1 ? "" : "s"}` : "Never downloaded",
            "The document, its file and its links disappear from the workspace",
            "Prefer lnkdrp_archive_doc if you might want this back",
          ],
          severity: severityFromTraffic({ recipientViews, activeLinks: live.length }),
          reversible: false,
        },
        args,
      );
      await ctx.api.deleteDoc(args.docId);
      return { ok: true, deleted: { docId: doc.id, title: doc.title, links: links.length } };
    }),
  );
}
