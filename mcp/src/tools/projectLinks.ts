/**
 * The project share-link tools: `lnkdrp_create_project_link`, `lnkdrp_list_project_links`,
 * `lnkdrp_update_project_link`, `lnkdrp_delete_project_link`
 * (docs/prds/lnkdrp-project-links.md, milestone M5).
 *
 * A *document* link sends one PDF to one recipient. A *project* link sends a whole project — the
 * data room — to one recipient: one `/p/:shareId` that lists every document in the project, with
 * its own label, audience, password, expiry and download setting, and its own analytics. Everything
 * the recipient opens behind it is attributed to that link, so "who came and what did they read"
 * has an answer per audience without the sender assembling a bundle of document links by hand.
 * That is the rule of thumb the descriptions below give an agent: several documents going to the
 * same audience is a project link; one document going to several audiences is
 * `lnkdrp_create_share_link`.
 *
 * Two things differ from `./shareLinks.ts` and both surface in the tool contracts:
 * - **Pro only.** Creating a *second* project link is a plan decision (PRD decision 7), so create
 *   can fail with `plan_limit` where the document version never can. Free keeps the project's
 *   default link working, which is why the gate is on create and not on list or update.
 * - **No `allowRevisionHistory`.** A project link has no single document whose versions a recipient
 *   could browse, so the field does not exist here rather than existing and doing nothing.
 *
 * All four are thin wrappers over `/api/projects/:projectId/links[/:linkId]`; the Pro gate, the
 * 50-per-project guard, validation and the default-link rules live in
 * `src/lib/share/projectLinks.ts`. The project reference plumbing (`projectId` | `projectSlug`,
 * slug resolution, the request-repo refusal) is shared with `./projects.ts` rather than repeated.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ApiClient, ApiProject, ApiProjectLink, ProjectLinkPatch } from "../api";
import { requireHumanConfirmation, severityFromTraffic } from "../confirm";
import type { ToolContext } from "../context";
import { handleTool, LINK_NOT_FOUND_ON_PROJECT, ToolError } from "../errors";
import { UNTRUSTED_LIMITS, untrustedOrNull } from "../untrusted";
import { loadProject, projectIdSchema, projectSlugSchema } from "./projects";
import { DISMISSED_PROMPT_NOTE, OBJECT_ID_RE, SAFETY_TAIL } from "./shared";

const linkIdSchema = z
  .string()
  .regex(OBJECT_ID_RE, "linkId must be a 24-character hex id")
  .describe("Project link id (24 hex chars), from lnkdrp_list_project_links");
const labelSchema = z
  .string()
  .min(1)
  .max(80)
  .describe(
    'Private name for this link, e.g. "Sequoia". Never shown to viewers of the project page. This is the human\'s word for ' +
      "the recipient, not yours: if they have not said who the link is for, ask them before calling instead of inventing a label.",
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
    "Password recipients must enter to reach the project page (1-128 chars), or null to remove it. " +
      "Use exactly the password the human gave you, whatever its length - a one-character password is allowed. Never substitute a longer one of your own: they will type theirs at the gate and be locked out. Tell them the password you set.",
  );
const allowDownloadSchema = z
  .boolean()
  .describe("Let recipients of this link download the PDFs they open through it. It governs every document in the project, whatever each document's own link allows.");
const confirmSchema = z
  .boolean()
  .optional()
  .describe(
    "Only for clients that cannot show the user a confirmation prompt. Set to true ONLY after you have shown the user what will be deleted and they have explicitly said yes in conversation. Never set it pre-emptively.",
  );

/** One project link plus its public URL. `/p/:shareId` — the project page, not a document's `/s/`. */
type ProjectLinkResult = ApiProjectLink & { shareUrl: string };

/** Add the `/p/:shareId` URL to a project link DTO. */
function withUrl(api: ApiClient, link: ApiProjectLink): ProjectLinkResult {
  return { ...link, shareUrl: api.projectPublicUrl(link.shareId) };
}

/**
 * Warn when a label is about to be a project's second link with that name.
 *
 * The label is how the human finds a link again; two identical ones on a project are
 * indistinguishable in every list and in `query`, which sorts default-then-newest and has nothing
 * else to tell them apart by. Allowed (a resend can be deliberate), but said out loud.
 *
 * Shared with `update`, which reaches the same end state by the quieter route: a rename adds no new
 * row to the listing to prompt a second look, so the silence there was the worse one. The document
 * side (`./shareLinks.ts`) warns on both halves; this file had the create half only.
 * `exceptLinkId` keeps an update from warning a link about its own name.
 */
function duplicateLabelWarning(label: string, existing: ApiProjectLink[], exceptLinkId?: string): string | undefined {
  const wanted = label.trim().toLowerCase();
  const same = existing.filter((l) => l.id !== exceptLinkId && l.label.trim().toLowerCase() === wanted);
  if (!same.length) return undefined;
  return (
    `This project already has ${same.length === 1 ? "a link" : `${same.length} links`} labelled "${label.trim()}" ` +
    `(shareId ${same.map((l) => l.shareId).join(", ")}). Tell the human, and consider a label or audience that tells them apart.`
  );
}

/** The project identity every tool echoes back, so a result says which data room it changed. */
function projectRef(project: ApiProject) {
  return {
    projectId: project.id,
    slug: project.slug,
    name: untrustedOrNull(project.name, "document", UNTRUSTED_LIMITS.short),
  };
}

export const createProjectLinkInputShape = {
  projectId: projectIdSchema,
  projectSlug: projectSlugSchema,
  label: labelSchema,
  audience: audienceSchema,
  allowDownload: allowDownloadSchema.default(false),
  password: passwordSchema,
  expiresAt: expiresAtSchema,
  enabled: z.boolean().default(true).describe("Whether the link works straight away."),
};

export const listProjectLinksInputShape = {
  projectId: projectIdSchema,
  projectSlug: projectSlugSchema,
  query: z
    .string()
    .trim()
    .max(120)
    .optional()
    .describe(
      "Search this project's links by label/audience instead of listing all of them, ranked by relevance. Omit to list " +
        "every link, the default link first.",
    ),
};

export const updateProjectLinkInputShape = {
  linkId: linkIdSchema,
  projectId: projectIdSchema,
  projectSlug: projectSlugSchema,
  label: labelSchema.optional(),
  audience: audienceSchema,
  enabled: z.boolean().optional().describe("Turn this link on or off. The project's other links are untouched."),
  allowDownload: allowDownloadSchema.optional(),
  password: passwordSchema,
  expiresAt: expiresAtSchema,
};

export const deleteProjectLinkInputShape = {
  confirm: confirmSchema,
  linkId: linkIdSchema,
  projectId: projectIdSchema,
  projectSlug: projectSlugSchema,
};

/** Register `lnkdrp_create_project_link`. */
export function registerCreateProjectLinkTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_create_project_link",
    {
      title: "Create project link",
      description:
        "Create a share link for a whole project, with its own label, audience, password, download and expiry settings. " +
        "The link opens the project's public page (/p/<shareId>), which lists every document in the project, and everything " +
        "the recipient does behind it - the documents they open, how long they read, what they download - is attributed to " +
        "this link alone. Prefer it over lnkdrp_create_share_link whenever several documents go to the same audience (a data " +
        "room, a diligence pack, a board folder): one link to send, one set of settings to revoke, and one answer to 'who " +
        "came and what did they read'. Use a document link instead when one document goes to several audiences. " +
        "This link's allowDownload governs every document opened through it, whatever each document's own link allows. " +
        "The label and audience are private to the sender, never shown to viewers, and are how the human finds this link " +
        "again months later, so they have to be the human's own words: if the request did not say who the link is for, ask " +
        "them that one question before calling. " +
        "Project links are a Pro feature (lnkdrp_whoami capabilities.projectLinks): on Free this fails with plan_limit and " +
        "nothing is created, while the project's existing default link keeps working. Creating an enabled link also turns " +
        "the project's public page back on if it was off, since the page is on whenever any link is live - the result says " +
        "so in warnings. " +
        SAFETY_TAIL,
      inputSchema: createProjectLinkInputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handleTool(async (args) => {
      const { project } = await loadProject(ctx.api, args);
      const settings: ProjectLinkPatch & { label: string } = {
        label: args.label,
        allowDownload: args.allowDownload,
        enabled: args.enabled,
      };
      if (args.audience !== undefined) settings.audience = args.audience;
      if (args.password !== undefined) settings.password = args.password;
      if (args.expiresAt !== undefined) settings.expiresAt = args.expiresAt;

      // Read before the write, and advisory: a listing that fails does not stop a create.
      const existing = await ctx.api.listProjectLinks(project.id).catch(() => [] as ApiProjectLink[]);
      const duplicateLabel = duplicateLabelWarning(args.label, existing);
      // Read before the write: `Project.shareEnabled` follows "any link is live", so an enabled
      // link on a switched-off project silently re-opens the public page for every recipient who
      // still holds a link. The agent has to be able to tell the human that happened.
      const pageWasOff = project.shareEnabled === false;

      const link = await ctx.api.createProjectLink(project.id, settings);

      const warnings = [
        duplicateLabel,
        pageWasOff && link.active
          ? "The project's public page was off and this link turned it back on: the page is live whenever any link is. " +
            "Links the sender had disabled stay disabled, but tell the human the page is reachable again."
          : undefined,
      ].filter((w): w is string => Boolean(w));

      return {
        project: projectRef(project),
        link: withUrl(ctx.api, link),
        shareUrl: ctx.api.projectPublicUrl(link.shareId),
        ...(warnings.length ? { warnings } : {}),
      };
    }),
  );
}

/** Register `lnkdrp_list_project_links`. */
export function registerListProjectLinksTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_list_project_links",
    {
      title: "List project links",
      description:
        "Every share link of a project, the default link first: label, audience, shareUrl (/p/<shareId>), status " +
        "(active|disabled|expired), whether a password is set, expiry, whether downloads are allowed, and that link's own " +
        "view and download counts. viewCount is the number of recipients who opened something through the link, the same " +
        "quantity it carries on a document link. It is not landings on the project page and not documents opened. publicPageEnabled says whether /p/<shareId> resolves for anyone right now, and it is derived from the rows below: it is true while at least one link is live. It is not the same question as the owner's switch - lnkdrp_update_project { publicPageEnabled: false } reads every link disabled and true restores those, but it cannot revive a link that has expired, which needs a new expiresAt via lnkdrp_update_project_link. links[].status is what a particular recipient gets, so read it per link before telling anyone their URL works. Pass query to search this " +
        "project's links by label/audience instead of listing all of them. Use a link's id with " +
        "lnkdrp_update_project_link / lnkdrp_delete_project_link. Archived (deleted) links are not listed. An empty links list does NOT mean the project is private: a new project's default link has no row until the first write, so check publicPageEnabled, and read note when it is present. " +
        SAFETY_TAIL,
      inputSchema: listProjectLinksInputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async (args) => {
      const { project } = await loadProject(ctx.api, args);
      const links = await ctx.api.listProjectLinks(project.id, args.query);
      /**
       * A live public page with no link row to show for it.
       *
       * A project's default link is materialised lazily — listing is a read and deliberately does
       * not write one (src/lib/share/projectLinks.ts) — so a brand-new project answers `links: []`
       * while `/p/:shareId` is already serving. An agent asked "is this shared with anyone?" then
       * says no, and an agent asked to revoke it finds nothing to revoke, both about a project
       * anyone holding the URL can read right now. Say so instead, and say where the handle is.
       */
      const unmaterialisedDefault = !args.query && project.shareEnabled && links.length === 0;
      /**
       * "Does the page resolve" answered from the rows, not from `Project.shareEnabled`.
       *
       * That field is denormalised "at least one link is live", and it is only recomputed when a
       * link is *written* (`syncProjectShareState`, src/lib/share/projectLinks.ts). Expiry is the
       * passage of time and not a write, so a room whose every link has expired keeps reporting
       * `publicPageEnabled: true` forever while `/p/:shareId` 404s for everyone holding it. An
       * agent asked "is the data room still reachable?" answered yes about a dead page. Each row's
       * `active` is evaluated live (enabled, not archived, not expired), so the rows already knew.
       * `./shared.ts` fixed the same class of bug on the document side for the same reason.
       *
       * Two cases cannot be derived and keep the stored flag: a `query`, which returns a subset and
       * says nothing about the links it filtered out, and the unmaterialised default below, where
       * the page is serving with no row to show for it.
       */
      const derivable = !args.query && links.length > 0;
      const anyLive = links.some((l) => l.active);
      const publicPageEnabled = derivable ? anyLive : project.shareEnabled;
      // Say why the two disagree, because the stale one is what every other surface still shows the
      // owner, and because an expired link is not something the page switch can bring back.
      const staleFlag = derivable && project.shareEnabled !== null && project.shareEnabled !== anyLive;
      const expiredCount = links.filter((l) => l.status === "expired").length;
      const liveCount = links.filter((l) => l.active).length;
      const warnings = staleFlag
        ? [
            anyLive
              ? `This project's stored public-page switch reads off, but ${liveCount} of its links ${liveCount === 1 ? "is" : "are"} live and ` +
                "serving: publicPageEnabled above is derived from the rows, which are what a recipient meets."
              : `This project's public page does not resolve for anyone: none of its ${links.length} link${links.length === 1 ? " is" : "s are"} live` +
                `${expiredCount ? ` (${expiredCount} expired)` : ""}. The project's stored switch still reads on - it is only recomputed when a link ` +
                "is written, and expiry is not a write - so the app and lnkdrp_get_project will still say the page is on. " +
                "publicPageEnabled above is derived from the rows. An expired link cannot be revived with " +
                "lnkdrp_update_project { publicPageEnabled: true }; give it a new expiresAt with lnkdrp_update_project_link.",
          ]
        : [];
      return {
        project: projectRef(project),
        // `null` only when neither the rows nor the route said; the project docs route always does.
        publicPageEnabled,
        links: links.map((l) => withUrl(ctx.api, l)),
        ...(warnings.length ? { warnings } : {}),
        ...(unmaterialisedDefault
          ? {
              note:
                "This project's public page is live and reachable at its publicUrl, but its default link has no row yet " +
                "(it is created on the first write). There is nothing here to revoke by linkId: turn the page off with " +
                "lnkdrp_update_project { publicPageEnabled: false }, which closes it for everyone.",
            }
          : {}),
      };
    }),
  );
}

/** Register `lnkdrp_update_project_link`. */
export function registerUpdateProjectLinkTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_update_project_link",
    {
      title: "Update project link",
      description:
        "Change one project link: label, audience, enabled, allowDownload, password (string to set, null to remove), " +
        "Enabling a link can republish the project's public page: if the page was switched off, turning one link back " +
        "on restores every link that switch had disabled (links revoked on their own stay revoked), and the response " +
        "then carries a warnings array naming them. " +
        "expiresAt (ISO date or null). At least one setting is required. Disabling a link revokes that recipient's access to " +
        "the whole project at once - the documents themselves, their own links and every other recipient's project link are " +
        "untouched - which is how a project link is revoked without deleting it and losing nothing of its analytics. " +
        "Changing allowDownload changes it for every document opened through this link. Editing is not a plan decision: a " +
        "workspace that has dropped to Free can still edit, disable and re-enable the links it already has. " +
        "warnings also cover a label that another link on this project already carries: two links with one name are " +
        "indistinguishable in every listing, and a rename adds no new row to prompt a second look. " +
        SAFETY_TAIL,
      inputSchema: updateProjectLinkInputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async (args) => {
      const patch: ProjectLinkPatch = {};
      if (args.label !== undefined) patch.label = args.label;
      if (args.audience !== undefined) patch.audience = args.audience;
      if (args.enabled !== undefined) patch.enabled = args.enabled;
      if (args.allowDownload !== undefined) patch.allowDownload = args.allowDownload;
      if (args.password !== undefined) patch.password = args.password;
      if (args.expiresAt !== undefined) patch.expiresAt = args.expiresAt;
      if (Object.keys(patch).length === 0) {
        throw new ToolError("validation", "Pass at least one of label, audience, enabled, allowDownload, password, expiresAt.");
      }
      const { project } = await loadProject(ctx.api, args);
      // The label listing has to be taken before the PATCH or the old label is already gone, and
      // only when a rename is actually being asked for: every other setting leaves the names alone.
      const existing = args.label === undefined ? [] : await ctx.api.listProjectLinks(project.id).catch(() => [] as ApiProjectLink[]);
      const { link, warnings } = await ctx.api.updateProjectLink(project.id, args.linkId, patch);
      const allWarnings = [
        // A rename onto a sibling's name is the same end state as creating a duplicate, and create
        // has warned about it since M5; the rename was the half that stayed quiet.
        args.label === undefined ? undefined : duplicateLabelWarning(args.label, existing, args.linkId),
        // Turning a link on can republish the room and bring back the links its page switch had
        // taken down — a change to who can reach the data room, reported to the caller that caused
        // it rather than left to be discovered by listing.
        ...warnings,
      ].filter((w): w is string => Boolean(w));
      return {
        project: projectRef(project),
        link: withUrl(ctx.api, link),
        shareUrl: ctx.api.projectPublicUrl(link.shareId),
        ...(allWarnings.length ? { warnings: allWarnings } : {}),
      };
    }),
  );
}

/** Register `lnkdrp_delete_project_link`. */
export function registerDeleteProjectLinkTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_delete_project_link",
    {
      title: "Delete project link",
      description:
        "Delete one project link. The link stops working immediately - the recipient sees 'this link is no longer " +
        "available', with nothing about the project - and this cannot be undone; its past analytics are kept in the " +
        "project's totals. The recipient loses the whole project, not one document, so this is the bigger of " +
        "the two deletes - lnkdrp_update_project_link { enabled: false } revokes the same access reversibly and is usually " +
        "what the human means. A project's default link cannot be deleted (validation error) - disable it instead, since " +
        "/p/<shareId> is the URL every earlier recipient already holds. " +
        "DESTRUCTIVE: this tool confirms with the human before acting. If the client supports it, the user is shown the " +
        "link, its traffic and a yes/no prompt directly. If not, the call fails with requiresConfirmation and a preview in " +
        "details - show that preview to the user, ask them, and call again with confirm: true only if they say yes. " +
        DISMISSED_PROMPT_NOTE +
        "A preview with severity 'high' means recipients have opened documents through this link; do not confirm that on " +
        "your own judgement. " +
        SAFETY_TAIL,
      inputSchema: deleteProjectLinkInputShape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async (args) => {
      // Look before deleting: the preview is built from the same list the agent already reads, so
      // the person confirming sees the link's real label and real traffic, not an id.
      const { project, total } = await loadProject(ctx.api, args);
      const links = await ctx.api.listProjectLinks(project.id);
      const link = links.find((l) => l.id === args.linkId);
      // Same fault, same sentence as the mapper - and as the projectId one line above, which has
      // always pointed at lnkdrp_list_projects. Two ids in one handler held to two standards: a
      // bad projectId got a next step, a bad linkId got a full stop, and the likeliest way to hold
      // a wrong linkId here is a document link's id, which only this wording names.
      if (!link) throw new ToolError("not_found", LINK_NOT_FOUND_ON_PROJECT);
      if (link.isDefault) {
        throw new ToolError("validation", "The project's default link cannot be deleted; disable it with lnkdrp_update_project_link instead.");
      }
      const severity = severityFromTraffic({ recipientViews: link.viewCount });
      await requireHumanConfirmation(
        server,
        {
          headline: `Delete the project link "${link.label}" on "${project.name || "this project"}"`,
          facts: [
            link.viewCount > 0
              ? `Opened by ${link.viewCount} recipient${link.viewCount === 1 ? "" : "s"}${link.lastViewedAt ? `, most recently ${link.lastViewedAt.slice(0, 10)}` : ""}`
              : "No recipient has opened anything through it",
            link.downloadCount > 0 ? `Downloaded ${link.downloadCount} time${link.downloadCount === 1 ? "" : "s"}` : "Nothing downloaded through it",
            // Measured, not assumed: /p/:shareId answers a deleted link with a "no longer
            // available" notice, not a 404, and does not name the project. Saying "not found" here
            // would have the human picture something the recipient never sees.
            `Anyone holding ${link.shareId} loses the whole project - all ${total} document${total === 1 ? "" : "s"} - and sees "this link is no longer available" from now on`,
            "The documents, their own links and every other recipient's project link are untouched",
            "Its analytics stay in the project's totals",
            ...(link.audience ? [`Audience note: ${link.audience}`] : []),
          ],
          severity,
          reversible: false,
        },
        args,
      );
      await ctx.api.deleteProjectLink(project.id, args.linkId);
      return {
        project: projectRef(project),
        ok: true,
        deleted: { linkId: link.id, shareId: link.shareId, label: link.label },
        severity,
      };
    }),
  );
}
