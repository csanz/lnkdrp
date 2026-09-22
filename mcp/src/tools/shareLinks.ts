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
import { handleTool, LINK_NOT_FOUND_ON_DOC, ToolError } from "../errors";
import { requireHumanConfirmation, severityFromTraffic } from "../confirm";
import { DISMISSED_PROMPT_NOTE, docIdSchema, OBJECT_ID_RE, SAFETY_TAIL } from "./shared";

const linkIdSchema = z.string().regex(OBJECT_ID_RE, "linkId must be a 24-character hex id").describe("Share link id (24 hex chars), from lnkdrp_list_share_links");
const labelSchema = z
  .string()
  .min(1)
  .max(80)
  .describe(
    'Private name for this link, e.g. "Sequoia". Never shown to viewers. This is the human\'s word for the recipient, not ' +
      "yours: if they have not said who the link is for, ask them before calling instead of inventing a label.",
  );
const audienceSchema = z
  .string()
  .max(120)
  .nullable()
  .optional()
  .describe(
    'Private note about who this link is for, e.g. "Sequoia · Roelof". Never shown to viewers. Fill it from what the ' +
      "human told you; leave it out rather than guessing.",
  );
const expiresAtSchema = z.string().nullable().optional().describe("ISO date when the link stops working (must be in the future), or null to never expire.");
const passwordSchema = z
  .string()
  .min(1)
  .max(128)
  .nullable()
  .optional()
  .describe(
    "Password viewers must enter (1-128 chars), or null to remove it. " +
      "Use exactly the password the human gave you, whatever its length - a one-character password is allowed. Never substitute a longer one of your own: they will type theirs at the gate and be locked out. Tell them the password you set; the owner can also reveal it later in the link's settings.",
  );

/** One link plus its public URL; `planWarning` is folded in by the callers that can hit the cap. */
type ShareLinkResult = ApiShareLink & { shareUrl: string; docArchived?: true };

/** Add the `/s/:shareId` URL to a link DTO. */
function withUrl(api: ApiClient, link: ApiShareLink): ShareLinkResult {
  return { ...link, shareUrl: api.shareUrl(link.shareId) };
}

/**
 * One link row, told the truth about the document it hangs off.
 *
 * Archive state lives on the document, not the link row: an archived document keeps each link's
 * own enabled/expiry state so unarchiving restores exactly what was live, so
 * `src/lib/share/links.ts` derives `status` from the row alone and a link on an archived document
 * still comes back "active". Every read surface already compensates - `lnkdrp_list_share_links`
 * below, `withDefaultLinkState` in ./shared, and `lnkdrp_get_share`, which refuses the shareId
 * outright - but `create`/`update` returned the DTO straight through, so the two tools that hand
 * an agent a fresh shareUrl were the only ones saying "active" about a URL that resolves for
 * nobody. One helper, so a fourth caller cannot drift back.
 */
function linkRow(api: ApiClient, link: ApiShareLink, docArchived: boolean): ShareLinkResult {
  const row = withUrl(api, link);
  if (!docArchived) return row;
  return { ...row, active: false, status: "archived", docArchived: true };
}

/** Said in the same response as the shareUrl, because that URL is what the agent is about to send. */
const ARCHIVED_DOC_WARNING =
  "This document is archived, so none of its links resolve: anyone opening this shareUrl gets \"not found\". The link's " +
  "own settings are kept, and lnkdrp_archive_doc { archived: false } brings the document and its links back. Tell the " +
  "human before they send it.";

/**
 * Warn when a label is about to be a document's second link with that name.
 *
 * The label is how the human finds a link again; two identical ones on a document are
 * indistinguishable in every list and search. Allowed (a resend can be deliberate), but said.
 * Shared with `update`, which is the same end state by a quieter route: renaming produces no new
 * row in the list to prompt a second look, so the silence there was the worse one. `exceptLinkId`
 * keeps an update from warning a link about itself.
 */
function duplicateLabelWarning(label: string, existing: ApiShareLink[], exceptLinkId?: string): string | undefined {
  const wanted = label.trim().toLowerCase();
  const same = existing.filter((l) => l.id !== exceptLinkId && l.label.trim().toLowerCase() === wanted);
  if (!same.length) return undefined;
  return (
    `This document already has ${same.length === 1 ? "a link" : `${same.length} links`} labelled "${label.trim()}" ` +
    `(shareId ${same.map((l) => l.shareId).join(", ")}). Tell the human, and consider a label or audience that tells them apart.`
  );
}

/**
 * Human sentence for the Free *document* cap when a workspace is near it.
 *
 * It is a heads-up, never a refusal: links are not plan-capped, so creating one always succeeds.
 * The note exists because an agent that has just made a link is well placed to tell its user the
 * workspace is close to the limit on *documents*, which is the next thing that will stop them.
 *
 * The lead sentence follows the link's real state: on an archived document it used to open "This
 * link is active", contradicting the very row it was attached to.
 */
function planNote(warning: PlanWarning | undefined, siteUrl: string, docArchived = false): string | undefined {
  if (!warning) return undefined;
  const lead = docArchived ? "This link does not resolve while the document is archived." : "This link is active.";
  return `${lead} Note the workspace is using ${warning.used} of ${warning.max} shared documents on Free. Links are unlimited; documents are not. The owner can upgrade at ${siteUrl}/pricing.`;
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
  query: z
    .string()
    .trim()
    .max(120)
    .optional()
    .describe(
      "Full-text search this document's links by label/audience instead of listing all of them - ranked by " +
        "relevance, whole-word matches only (not substrings: \"a16z\" matches, \"nest\" does not). Omit to list every link, default first.",
    ),
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
  confirm: z
    .boolean()
    .optional()
    .describe(
      "Only for clients that cannot show the user a confirmation prompt. Set to true ONLY after you have shown the user what will be deleted and they have explicitly said yes in conversation. Never set it pre-emptively.",
    ),
  linkId: linkIdSchema,
  docId: docIdSchema,
};

/**
 * Register `lnkdrp_create_share_link`.
 *
 * The description names the 50-link ceiling (`SHARE_LINKS_PER_DOC_MAX`) because the sentence beside
 * it, "links are never plan-capped ... one per investor or counterparty", is the one an agent plans
 * against, and on its own it reads as "no ceiling at all". There is one, it is not a plan decision,
 * and `mapApiError` already goes to the trouble of returning it as `validation` + `too_many_links`
 * so an agent stops retrying. It stops sooner still if it knew the number before it started.
 * tests/lib/mcpRoundSevenDescriptions.test.ts reads the constant out of src/lib/share/links.ts, so
 * moving the cap fails the suite rather than leaving a wrong number here.
 */
export function registerCreateShareLinkTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_create_share_link",
    {
      title: "Create share link",
      description:
        "Create an extra share link for a document, with its own label, audience, password, download and expiry settings. " +
        "One link per recipient is the point: each link has separate view/download stats (lnkdrp_get_share_stats accepts its " +
        "shareId) and can be disabled on its own. The label and audience are private to the sender and never shown to viewers. " +
        "They are also how the human finds this link again months later, so they have to be the human's own words. If the " +
        "request did not say who the link is for, ask them that one question before calling - a made-up label is worse than " +
        "a moment's pause. " +
        "Links are never plan-capped: a document may carry one per investor or counterparty on any plan, so a plan never " +
        "forces a new link off; it is enabled unless you pass enabled: false. planWarning only appears when the workspace is near its separate cap on shared " +
        "documents. " +
        "There is one ceiling, and no plan lifts it: a document holds at most 50 links. The 51st fails with a validation " +
        "error carrying code too_many_links, which is permanent for that document until you delete a link you no longer " +
        "need (lnkdrp_delete_share_link), reuse one it already has (lnkdrp_list_share_links), or send that audience a " +
        "project link instead (lnkdrp_create_project_link), which carries several documents on one URL. " +
        "If the document is archived the link is still created and keeps its settings, but it comes back status 'archived' " +
        "with a warning: nothing resolves until lnkdrp_archive_doc { archived: false } brings the document back. " +
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
      // `null` means "remove the password" when updating; on a link that does not exist yet it is
      // almost always a lost value, and accepting it quietly produced an open link where the sender
      // had asked for a gate.
      if (args.password === null) {
        throw new ToolError(
          "validation",
          "password: null has no meaning when creating a link - there is no password to remove. Omit it for an open link, " +
            "or pass the password the human gave you.",
        );
      }
      if (args.password !== undefined) settings.password = args.password;
      if (args.expiresAt !== undefined) settings.expiresAt = args.expiresAt;
      // Two pre-flight reads, both about state this call is going to report on, both taken before
      // the write so they describe the document as it was asked about. The listing is advisory and
      // fails soft; the document read is not, because it decides whether the URL we hand back
      // resolves at all, so a failure there stops the call before anything is created.
      const [doc, existing] = await Promise.all([
        ctx.api.getDoc(args.docId),
        ctx.api.listShareLinks(args.docId).catch(() => []),
      ]);
      const { link, planWarning } = await ctx.api.createShareLink(args.docId, settings);
      const note = planNote(planWarning, ctx.api.baseUrl, doc.isArchived);
      const warnings = [
        doc.isArchived ? ARCHIVED_DOC_WARNING : undefined,
        duplicateLabelWarning(args.label, existing),
      ].filter((w): w is string => Boolean(w));
      return {
        link: linkRow(ctx.api, link, doc.isArchived),
        shareUrl: ctx.api.shareUrl(link.shareId),
        ...(doc.isArchived ? { docArchived: true } : {}),
        ...(planWarning ? { planWarning } : {}),
        ...(note ? { planNote: note } : {}),
        ...(warnings.length ? { warnings } : {}),
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
        "Every share link of a document, the default link first: label, audience, shareUrl, status (active|disabled|expired|archived - " +
        "archived means the document itself is archived, so none of its links resolve until it is brought back), " +
        "whether a password is set, expiry, and that link's view and download counts. Pass query to search this document's " +
        "links by label/audience instead of listing all of them, ranked by relevance. If you do not already know which " +
        "document a link is on, use lnkdrp_find_share_link instead - it searches by name across the whole workspace. " +
        "Use a link's id with " +
        "lnkdrp_update_share_link / lnkdrp_delete_share_link, or its shareId with lnkdrp_get_share_stats. " +
        SAFETY_TAIL,
      inputSchema: listShareLinksInputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async (args) => {
      // The document's archive state decides whether any of these links opens, and it does not live
      // on the link rows: an archived document keeps each link's own enabled/expiry so unarchiving
      // restores exactly what was live. Reported here so a reader is never told "active" about a
      // link that resolves for nobody.
      const [page, doc] = await Promise.all([
        ctx.api.listShareLinksPage(args.docId, args.query),
        ctx.api.getDoc(args.docId),
      ]);
      const rows = page.links.map((l) => linkRow(ctx.api, l, doc.isArchived));
      return {
        docId: args.docId,
        ...(doc.isArchived ? { docArchived: true } : {}),
        // The route pages at 100. Saying how many there are makes a short answer readable as short,
        // rather than as all of them — which is what it used to look like.
        total: page.total,
        links: rows,
        ...(page.truncated
          ? {
              warnings: [
                `This document has ${page.total} links and this response carries ${rows.length}. Narrow with query, or ` +
                  "ask about a specific link by its shareId.",
              ],
            }
          : {}),
      };
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
        "access without touching the document's other links. Links are never plan-capped, so re-enabling always succeeds; " +
        "planWarning only notes when the workspace is near its separate cap on shared documents. " +
        "warnings also cover the two things the link row cannot show: the document being archived, so none of its links " +
        "resolve, and a label that another link on this document already carries. " +
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
      // Same two pre-flight reads as create, and for the same reason: this call reports a status
      // and a shareUrl, and neither is knowable from the link row alone. The label listing has to
      // be taken before the PATCH or the old label is already gone; it is only fetched when a
      // rename is actually being asked for.
      const [doc, existing] = await Promise.all([
        ctx.api.getDoc(args.docId),
        args.label === undefined ? Promise.resolve<ApiShareLink[]>([]) : ctx.api.listShareLinks(args.docId).catch(() => []),
      ]);
      const { link, planWarning, warnings } = await ctx.api.updateShareLink(args.docId, args.linkId, patch);
      const note = planNote(planWarning, ctx.api.baseUrl, doc.isArchived);
      const allWarnings = [
        doc.isArchived ? ARCHIVED_DOC_WARNING : undefined,
        args.label === undefined ? undefined : duplicateLabelWarning(args.label, existing, args.linkId),
        // Enabling one link can re-share the whole document and restore the links its switch had
        // taken down. The agent that made that happen has to be told, in the response to the call
        // that did it, not left to notice by listing afterwards.
        ...warnings,
      ].filter((w): w is string => Boolean(w));
      return {
        link: linkRow(ctx.api, link, doc.isArchived),
        shareUrl: ctx.api.shareUrl(link.shareId),
        ...(doc.isArchived ? { docArchived: true } : {}),
        ...(planWarning ? { planWarning } : {}),
        ...(note ? { planNote: note } : {}),
        ...(allWarnings.length ? { warnings: allWarnings } : {}),
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
        "Delete one share link. The link stops resolving immediately and this cannot be undone; its past analytics are kept. " +
        "A document's default link cannot be deleted (validation error) - disable it with lnkdrp_update_share_link instead. " +
        "DESTRUCTIVE: this tool confirms with the human before acting. If the client supports it, the user is shown the link, " +
        "its traffic and a yes/no prompt directly. If not, the call fails with requiresConfirmation and a preview in details - " +
        "show that preview to the user, ask them, and call again with confirm: true only if they say yes. " +
        DISMISSED_PROMPT_NOTE +
        "A preview with " +
        "severity 'high' means recipients have opened this link; do not confirm that on your own judgement. " +
        SAFETY_TAIL,
      inputSchema: deleteShareLinkInputShape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async (args) => {
      // Look before deleting: the preview is built from the same list the agent already reads, so
      // the person confirming sees the link's real label and real traffic, not an id.
      const links = await ctx.api.listShareLinks(args.docId);
      const link = links.find((l) => l.id === args.linkId);
      // The same sentence the mapper gives for the same fault. Resolving the link here means the
      // API never 404s, so mapApiError never runs, and this branch used to answer a stale linkId
      // with a shorter message of its own that named no way to find the right one - on the tool
      // where the next guess deletes something.
      if (!link) throw new ToolError("not_found", LINK_NOT_FOUND_ON_DOC);
      if (link.isDefault) throw new ToolError("validation", "The default link cannot be deleted; disable it with lnkdrp_update_share_link instead.");
      const doc = await ctx.api.getDoc(args.docId);
      const severity = severityFromTraffic({ recipientViews: link.viewCount });
      await requireHumanConfirmation(
        server,
        {
          headline: `Delete the share link "${link.label}" on "${doc.title ?? "this document"}"`,
          facts: [
            link.viewCount > 0
              ? `Opened by ${link.viewCount} recipient${link.viewCount === 1 ? "" : "s"}${link.lastViewedAt ? `, most recently ${link.lastViewedAt.slice(0, 10)}` : ""}`
              : "Never opened by a recipient",
            link.downloadCount > 0 ? `Downloaded ${link.downloadCount} time${link.downloadCount === 1 ? "" : "s"}` : "Never downloaded",
            `Anyone holding ${link.shareId} will get "not found" from now on`,
            "Its analytics stay in the document's totals",
            ...(link.audience ? [`Audience note: ${link.audience}`] : []),
          ],
          severity,
          reversible: false,
        },
        args,
      );
      await ctx.api.deleteShareLink(args.docId, args.linkId);
      return { ok: true, deleted: { linkId: link.id, shareId: link.shareId, label: link.label }, severity };
    }),
  );
}
