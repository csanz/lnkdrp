/**
 * The share-link tools: `lnkdrp_create_share_link`, `lnkdrp_list_share_links`,
 * `lnkdrp_update_share_link`, `lnkdrp_delete_share_link`
 * (docs/prds/lnkdrp-multi-links.md).
 *
 * A document owns any number of links, each with its own label, audience, settings and analytics,
 * so an agent can say "create an exclusive link for Sequoia" and then report on that link alone
 * (`lnkdrp_get_share_stats { shareId }`). Labels and audiences are private to the sender: they are
 * never shown to a viewer of `/s/:shareId`.
 *
 * All four are thin wrappers over `/api/docs/:docId/links[/:linkId]`; the cap, validation and the
 * default-link rules live in the web app's `src/lib/share/links.ts`.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ApiClient, ApiShareLink, PlanWarning, ShareLinkPatch } from "../api";
import type { ToolContext } from "../context";
import { handleTool, ToolError } from "../errors";
import { docIdSchema, OBJECT_ID_RE, SAFETY_TAIL } from "./shared";

const linkIdSchema = z.string().regex(OBJECT_ID_RE, "linkId must be a 24-character hex id").describe("Share link id (24 hex chars), from lnkdrp_list_share_links");
const labelSchema = z.string().min(1).max(80).describe("Private name for this link, e.g. \"Sequoia\". Never shown to viewers.");
const audienceSchema = z.string().max(120).nullable().optional().describe("Private note about who this link is for, e.g. \"Sequoia · Roelof\". Never shown to viewers.");
const expiresAtSchema = z.string().nullable().optional().describe("ISO date when the link stops working (must be in the future), or null to never expire.");
const passwordSchema = z.string().min(8).max(128).nullable().optional().describe("Password viewers must enter (8-128 chars), or null to remove it.");

/** One link plus its public URL; `planWarning` is folded in by the callers that can hit the cap. */
type ShareLinkResult = ApiShareLink & { shareUrl: string };

/** Add the `/s/:shareId` URL to a link DTO. */
function withUrl(api: ApiClient, link: ApiShareLink): ShareLinkResult {
  return { ...link, shareUrl: api.shareUrl(link.shareId) };
}

/** Human sentence for the Free active-link cap, so the agent reports it instead of silently returning a dead link. */
function planNote(warning: PlanWarning | undefined, siteUrl: string): string | undefined {
  if (!warning) return undefined;
  return `Free workspaces allow ${warning.max} active share links (${warning.used} in use). Upgrade at ${siteUrl}/pricing to lift the cap.`;
}

export const createShareLinkInputShape = {
  docId: docIdSchema,
  label: labelSchema,
  audience: audienceSchema,
  allowDownload: z.boolean().default(false).describe("Let viewers of this link download the PDF."),
  password: passwordSchema,
  expiresAt: expiresAtSchema,
  allowRevisionHistory: z.boolean().default(false).describe("Let viewers of this link see earlier versions (Pro feature)."),
  enabled: z.boolean().default(true).describe("Whether the link works straight away."),
};

export const listShareLinksInputShape = {
  docId: docIdSchema,
};

export const updateShareLinkInputShape = {
  linkId: linkIdSchema,
  docId: docIdSchema,
  label: labelSchema.optional(),
  audience: audienceSchema,
  enabled: z.boolean().optional().describe("Turn this link on or off. Other links are untouched."),
  allowDownload: z.boolean().optional().describe("Let viewers of this link download the PDF."),
  password: passwordSchema,
  expiresAt: expiresAtSchema,
  allowRevisionHistory: z.boolean().optional().describe("Let viewers of this link see earlier versions (Pro feature)."),
};

export const deleteShareLinkInputShape = {
  linkId: linkIdSchema,
  docId: docIdSchema,
};

/** Register `lnkdrp_create_share_link`. */
export function registerCreateShareLinkTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_create_share_link",
    {
      title: "Create share link",
      description:
        "Create an extra share link for a document, with its own label, audience, password, download and expiry settings. " +
        "One link per recipient is the point: each link has separate view/download stats (lnkdrp_get_share_stats accepts its " +
        "shareId) and can be disabled on its own. The label and audience are private to the sender and never shown to viewers. " +
        "At the Free plan's active-link cap the link is still created but disabled, and planWarning explains why. " +
        SAFETY_TAIL,
      inputSchema: createShareLinkInputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handleTool(async (args) => {
      const settings: ShareLinkPatch & { label: string } = {
        label: args.label,
        allowDownload: args.allowDownload,
        allowRevisionHistory: args.allowRevisionHistory,
        enabled: args.enabled,
      };
      if (args.audience !== undefined) settings.audience = args.audience;
      if (args.password !== undefined) settings.password = args.password;
      if (args.expiresAt !== undefined) settings.expiresAt = args.expiresAt;
      const { link, planWarning } = await ctx.api.createShareLink(args.docId, settings);
      const note = planNote(planWarning, ctx.api.baseUrl);
      return {
        link: withUrl(ctx.api, link),
        shareUrl: ctx.api.shareUrl(link.shareId),
        ...(planWarning ? { planWarning } : {}),
        ...(note ? { planNote: note } : {}),
      };
    }),
  );
}

/** Register `lnkdrp_list_share_links`. */
export function registerListShareLinksTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_list_share_links",
    {
      title: "List share links",
      description:
        "Every share link of a document, the default link first: label, audience, shareUrl, status (active|disabled|expired), " +
        "whether a password is set, expiry, and that link's view and download counts. Use a link's id with " +
        "lnkdrp_update_share_link / lnkdrp_delete_share_link, or its shareId with lnkdrp_get_share_stats. " +
        SAFETY_TAIL,
      inputSchema: listShareLinksInputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async (args) => {
      const links = await ctx.api.listShareLinks(args.docId);
      return { docId: args.docId, links: links.map((l) => withUrl(ctx.api, l)) };
    }),
  );
}

/** Register `lnkdrp_update_share_link`. */
export function registerUpdateShareLinkTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_update_share_link",
    {
      title: "Update share link",
      description:
        "Change one share link: label, audience, enabled, allowDownload, password (string to set, null to remove), expiresAt " +
        "(ISO date or null), allowRevisionHistory. At least one setting is required. Disabling a link revokes that recipient's " +
        "access without touching the document's other links. Re-enabling at the Free cap leaves the link off and returns " +
        "planWarning. " +
        SAFETY_TAIL,
      inputSchema: updateShareLinkInputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async (args) => {
      const patch: ShareLinkPatch = {};
      if (args.label !== undefined) patch.label = args.label;
      if (args.audience !== undefined) patch.audience = args.audience;
      if (args.enabled !== undefined) patch.enabled = args.enabled;
      if (args.allowDownload !== undefined) patch.allowDownload = args.allowDownload;
      if (args.password !== undefined) patch.password = args.password;
      if (args.expiresAt !== undefined) patch.expiresAt = args.expiresAt;
      if (args.allowRevisionHistory !== undefined) patch.allowRevisionHistory = args.allowRevisionHistory;
      if (Object.keys(patch).length === 0) {
        throw new ToolError("validation", "Pass at least one of label, audience, enabled, allowDownload, password, expiresAt, allowRevisionHistory.");
      }
      const { link, planWarning } = await ctx.api.updateShareLink(args.docId, args.linkId, patch);
      const note = planNote(planWarning, ctx.api.baseUrl);
      return {
        link: withUrl(ctx.api, link),
        shareUrl: ctx.api.shareUrl(link.shareId),
        ...(planWarning ? { planWarning } : {}),
        ...(note ? { planNote: note } : {}),
      };
    }),
  );
}

/** Register `lnkdrp_delete_share_link`. */
export function registerDeleteShareLinkTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_delete_share_link",
    {
      title: "Delete share link",
      description:
        "Delete one share link. The link stops resolving immediately; its past analytics are kept. A document's default link " +
        "cannot be deleted (validation error) - disable it with lnkdrp_update_share_link instead. " +
        SAFETY_TAIL,
      inputSchema: deleteShareLinkInputShape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async (args) => {
      await ctx.api.deleteShareLink(args.docId, args.linkId);
      return { ok: true };
    }),
  );
}
