/**
 * The project tools: `lnkdrp_create_project`, `lnkdrp_list_projects`, `lnkdrp_get_project`,
 * `lnkdrp_add_docs_to_project`, `lnkdrp_remove_doc_from_project`, `lnkdrp_update_project` and
 * `lnkdrp_delete_project`.
 *
 * A project groups documents. Membership is many-to-many (`Doc.projectIds`), so adding a document
 * to a project never moves it out of another, and removing it never touches the document itself.
 * Every project also has a public page, `/p/:shareId`, on by default, that lists its documents whose
 * own links are on — which is why adding a document is described to the agent as publishing it
 * there.
 *
 * Thin wrappers over `/api/projects[/:id[/docs]]` and `PATCH /api/docs/:id { addProjectId |
 * removeProjectId }`. Two things the routes do not do, and these tools do before writing:
 * - Check that the project belongs to this workspace. `PATCH /api/docs/:id` accepts any well-formed
 *   `addProjectId`, so every membership change first reads the project through its
 *   workspace-scoped `GET /api/projects/:id/docs`.
 * - Keep request repos out. They live in the same collection, but the product hides them behind a
 *   feature flag, and a project tool must not become a side door to them (see `discover.ts`).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ApiClient, ApiProject } from "../api";
import { requireHumanConfirmation } from "../confirm";
import type { ToolContext } from "../context";
import { handleTool, isToolError, ToolError } from "../errors";
import { fingerprintArgs, IdempotencyStore } from "../idempotency";
import { UNTRUSTED_LIMITS, untrustedOrNull } from "../untrusted";
import { DISMISSED_PROMPT_NOTE, docIdSchema, OBJECT_ID_RE, SAFETY_TAIL } from "./shared";

/** Mirrors `MAX_PROJECT_NAME_LENGTH` in `src/app/api/projects/[projectSlug]/route.ts`. */
const MAX_PROJECT_NAME = 80;
const MAX_PROJECT_DESCRIPTION = 2000;
/** Pages of 50 scanned when resolving a slug the name search did not find (2,500 projects). */
const SLUG_SCAN_MAX_PAGES = 50;
/** Membership writes run a few at a time: 50 documents is two API calls each. */
const ADD_CONCURRENCY = 4;

export const projectIdSchema = z
  .string()
  .regex(OBJECT_ID_RE, "projectId must be a 24-character hex id")
  .optional()
  .describe("Project id (24 hex chars), from lnkdrp_list_projects or lnkdrp_create_project. Pass this or projectSlug.");
export const projectSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .optional()
  .describe('Project slug, e.g. "series-a-data-room", as lnkdrp_list_projects returns it. Pass this or projectId.');
const projectNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_PROJECT_NAME)
  .describe(
    `Project name (1-${MAX_PROJECT_NAME} chars), unique in the workspace. Use the human's name for it; if they did not give one, ask.`,
  );
const projectDescriptionSchema = z
  .string()
  .trim()
  .max(MAX_PROJECT_DESCRIPTION)
  .describe("Short description. It is shown on the project's public page, so keep it fit for recipients.");
const confirmSchema = z
  .boolean()
  .optional()
  .describe(
    "Only for clients that cannot show the user a confirmation prompt. Set to true ONLY after you have shown the user what will happen and they have explicitly said yes in conversation. Never set it pre-emptively.",
  );

export type ProjectRef = { projectId?: string | undefined; projectSlug?: string | undefined };

/** The project fields every tool returns. Names and descriptions are the workspace's own text. */
function projectView(api: ApiClient, p: ApiProject, extra: { docCount?: number | null } = {}) {
  const docCount = extra.docCount !== undefined ? extra.docCount : p.docCount;
  return {
    projectId: p.id,
    slug: p.slug,
    name: untrustedOrNull(p.name, "document", UNTRUSTED_LIMITS.short),
    description: untrustedOrNull(p.description, "document", UNTRUSTED_LIMITS.short),
    docCount,
    appUrl: api.projectAppUrl(p.id),
    ...(p.shareEnabled !== null
      ? {
          publicPageEnabled: p.shareEnabled,
          publicUrl: p.shareEnabled && p.shareId ? api.projectPublicUrl(p.shareId) : null,
        }
      : {}),
    createdDate: p.createdDate,
    updatedDate: p.updatedDate,
  };
}

/**
 * Fill in what only `GET /api/projects` carries. The create, update and docs routes return a project
 * without dates, and the docs route without a document count when searching, so get_project said
 * createdDate null (and docCount null with a query) while list_projects had real values, and a
 * create_project replay reported the docCount from creation time. One list call by name fixes all
 * three; failures leave the project as it was.
 */
async function withListedMeta(api: ApiClient, p: ApiProject): Promise<ApiProject> {
  if (p.createdDate && p.updatedDate && p.docCount !== null) return p;
  const listed = await api
    .listProjects({ q: p.name, limit: 50 })
    .then((page) => page.projects.find((x) => x.id === p.id) ?? null)
    .catch(() => null);
  if (!listed) return p;
  return {
    ...p,
    createdDate: p.createdDate ?? listed.createdDate,
    updatedDate: listed.updatedDate ?? p.updatedDate,
    docCount: listed.docCount ?? p.docCount,
  };
}

/** Exactly one of projectId / projectSlug. */
export function requireOneProjectRef(ref: ProjectRef): void {
  const has = [ref.projectId, ref.projectSlug].filter((v) => typeof v === "string" && v.length > 0).length;
  if (has !== 1) throw new ToolError("validation", "Pass exactly one of projectId or projectSlug.");
}

/**
 * Turn a slug into a project id. `GET /api/projects?q=` searches names, not slugs, so this first
 * searches for the slug with its hyphens as spaces (a slug is the lower-cased name), then falls
 * back to scanning the list, which is still one page for most workspaces.
 */
async function projectIdForSlug(api: ApiClient, slug: string): Promise<string> {
  const wanted = slug.toLowerCase();
  const guess = await api.listProjects({ q: wanted.replace(/-+/g, " ").trim(), page: 1, limit: 50 });
  const hit = guess.projects.find((p) => p.slug.toLowerCase() === wanted);
  if (hit) return hit.id;
  for (let page = 1; page <= SLUG_SCAN_MAX_PAGES; page++) {
    const res = await api.listProjects({ page, limit: 50 });
    const found = res.projects.find((p) => p.slug.toLowerCase() === wanted);
    if (found) return found.id;
    if (res.projects.length === 0 || page * 50 >= res.total) break;
  }
  throw new ToolError("not_found", `No project with the slug "${slug}" in this workspace. lnkdrp_list_projects lists them.`);
}

/**
 * Resolve a project reference to a verified, workspace-scoped, non-request project, and read one
 * page of its documents on the way (the same call is the existence check).
 */
export async function loadProject(
  api: ApiClient,
  ref: ProjectRef,
  docs: { page?: number | undefined; limit: number; q?: string | undefined; archived?: boolean | undefined } = { limit: 1 },
) {
  requireOneProjectRef(ref);
  const projectId = ref.projectId ?? (await projectIdForSlug(api, ref.projectSlug as string));
  const res = await api.getProjectDocs(projectId, docs);
  if (res.project.isRequest) {
    // Indistinguishable from "no such project" on purpose; see the file header.
    throw new ToolError("not_found", "No such project in this workspace. lnkdrp_list_projects lists the projects you can use.");
  }
  return res;
}

/** Run `fn` over `items` with at most `limit` in flight, keeping input order in the results. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Errors that will fail every document the same way; retrying per document only hides them. */
function isCallerWideError(err: unknown): boolean {
  return isToolError(err) && ["unauthorized", "key_revoked", "forbidden", "rate_limited"].includes(err.code);
}

/** Register `lnkdrp_create_project`. */
export function registerCreateProjectTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_create_project",
    {
      title: "Create project",
      description:
        "Create an empty project to group documents, e.g. a data room for one deal. Returns projectId, slug, name, the " +
        "project's page in the app (appUrl) and its public page (publicUrl). The public page is on from the start and lists " +
        "every document you later add whose share link is on - tell the human that, and turn it off with " +
        "lnkdrp_update_project { publicPageEnabled: false } if they do not want it. Add documents with " +
        "lnkdrp_add_docs_to_project. Project names are unique in a workspace (a duplicate is a validation error; " +
        "lnkdrp_list_projects finds the existing one). The Free plan allows a limited number of projects " +
        "(lnkdrp_whoami capabilities.projects); at the cap this fails with plan_limit, whose details list what still works " +
        "without upgrading. Retrying with the same idempotencyKey and arguments returns the same project; the same key with " +
        "different arguments is refused. " +
        SAFETY_TAIL,
      inputSchema: {
        idempotencyKey: z
          .string()
          .min(1)
          .max(128)
          .describe("Caller-chosen key (1-128 chars). Reusing it within 24h returns the same project instead of creating another."),
        name: projectNameSchema,
        description: projectDescriptionSchema.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handleTool(async (args) => {
      const orgId = ctx.whoami().orgId;
      const run = async () => {
        try {
          return await ctx.api.createProject({ name: args.name, description: args.description });
        } catch (err) {
          if (isToolError(err) && err.status === 409) {
            throw new ToolError(
              "validation",
              "A project with that name already exists in this workspace. Use it (lnkdrp_list_projects with the name as query finds its id) or pick another name.",
              { status: 409, details: { name: args.name } },
            );
          }
          throw err;
        }
      };
      const { value, replayed } = await ctx.idempotency.run(IdempotencyStore.key(orgId, "create_project", args.idempotencyKey), run, {
        fingerprint: fingerprintArgs(args),
      });
      // A new project's public page is on (the model default); the create route just does not echo it.
      const created: ApiProject = { ...value.project, shareEnabled: value.project.shareEnabled ?? true };
      // A replay describes the project as it is now, not as it was when first created.
      const project = await withListedMeta(ctx.api, replayed ? { ...created, docCount: null, updatedDate: null } : created);
      return {
        project: projectView(ctx.api, project),
        ...(value.planWarning ? { planWarning: value.planWarning } : {}),
        ...(replayed ? { replayed: true } : {}),
      };
    }),
  );
}

/** Register `lnkdrp_list_projects`. */
export function registerListProjectsTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_list_projects",
    {
      title: "List projects",
      description:
        "The workspace's projects, most recently updated first: projectId, slug, name, description, docCount and dates. " +
        "query matches project names and descriptions (not slugs). Page-based: total says how many match. Use a projectId " +
        "or slug with lnkdrp_get_project to see a project's documents, or with lnkdrp_add_docs_to_project. " +
        SAFETY_TAIL,
      inputSchema: {
        query: z.string().trim().max(200).optional().describe("Match project names and descriptions, case-insensitively. Omit to list all."),
        page: z.number().int().min(1).default(1).describe("1-based page number."),
        limit: z.number().int().min(1).max(50).default(25).describe("Projects per page (1-50)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async (args) => {
      const res = await ctx.api.listProjects({ q: args.query, page: args.page, limit: args.limit });
      return {
        total: res.total,
        page: res.page,
        limit: res.limit,
        hasMore: res.projects.length > 0 && res.page * res.limit < res.total,
        // The list route does not say whether each public page is on; lnkdrp_get_project does.
        projects: res.projects.map((p) => projectView(ctx.api, p)),
      };
    }),
  );
}

/** Register `lnkdrp_get_project`. */
export function registerGetProjectTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_get_project",
    {
      title: "Get project",
      description:
        "One project and a page of its documents, most recently updated first. Project: projectId, slug, name, description, " +
        "docCount, appUrl, publicPageEnabled and publicUrl (null while the public page is off). Documents: docId, shareId, " +
        "shareUrl, title, status, version and dates. archived: true shows the project's Archive view (its archived documents) " +
        "instead of the live ones; total then counts archived documents and docCount stays the live count. query narrows " +
        "the documents by title or default link slug. " +
        SAFETY_TAIL,
      inputSchema: {
        projectId: projectIdSchema,
        projectSlug: projectSlugSchema,
        query: z.string().trim().max(200).optional().describe("Only documents whose title or default link slug matches."),
        page: z.number().int().min(1).default(1).describe("1-based page of documents."),
        limit: z.number().int().min(1).max(50).default(25).describe("Documents per page (1-50)."),
        archived: z.boolean().default(false).describe("true lists the project's archived documents (its Archive view)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async (args) => {
      const res = await loadProject(ctx.api, args, { q: args.query, page: args.page, limit: args.limit, archived: args.archived });
      // The project's own tags, and each listed document's, in two reads rather than one per row.
      // Best-effort: tags are how a workspace files things, not part of what a project *is*.
      const [projectTags, docTags] = await Promise.all([
        ctx.api.tagsForTarget({ targetKind: "project", targetId: res.project.id }).catch(() => []),
        ctx.api.tagsForTargets({ targetKind: "doc", ids: res.docs.map((d) => d.id) }).catch(() => new Map()),
      ]);
      const asTagRows = (list: { name: string; slug: string; color: string }[]) =>
        list.map((t) => ({ name: t.name, slug: t.slug, color: t.color }));
      return {
        // Without a query the route's total is the project's cached document count.
        project: {
          ...projectView(
            ctx.api,
            // docCount is the live count; the route's total is only that without a query or the archive view.
            await withListedMeta(ctx.api, args.query || args.archived ? { ...res.project, docCount: null } : { ...res.project, docCount: res.total }),
          ),
          tags: asTagRows(projectTags),
        },
        total: res.total,
        page: res.page,
        limit: res.limit,
        hasMore: res.docs.length > 0 && res.page * res.limit < res.total,
        docs: res.docs.map((d) => ({
          docId: d.id,
          shareId: d.shareId,
          shareUrl: d.shareId ? ctx.api.shareUrl(d.shareId) : null,
          title: untrustedOrNull(d.title, "document", UNTRUSTED_LIMITS.title),
          status: d.status,
          version: d.version,
          previewImageUrl: d.previewImageUrl,
          createdDate: d.createdDate,
          updatedDate: d.updatedDate,
          tags: asTagRows(docTags.get(d.id) ?? []),
        })),
      };
    }),
  );
}

/** Register `lnkdrp_add_docs_to_project`. */
export function registerAddDocsToProjectTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_add_docs_to_project",
    {
      title: "Add documents to project",
      description:
        "Put 1-50 documents into a project. A document can be in many projects, so this never takes it out of another one. " +
        "Reports added, alreadyInProject (nothing to do) and notFound (unknown, deleted or archived - the same documents " +
        "lnkdrp_list_docs would not return; unarchive with lnkdrp_archive_doc first), plus failed with an error per document " +
        "if any write failed. " +
        "Safe to retry. While the project's public page is on (lnkdrp_get_project publicPageEnabled), every added document " +
        "whose share link is on is listed there for anyone with publicUrl - mention it to the human when the page is on. " +
        SAFETY_TAIL,
      inputSchema: {
        projectId: projectIdSchema,
        projectSlug: projectSlugSchema,
        docIds: z.array(docIdSchema).min(1).max(50).describe("Documents to add (1-50), from lnkdrp_list_docs."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async (args) => {
      const { project } = await loadProject(ctx.api, args);
      const docIds = [...new Set(args.docIds.map((id) => id.toLowerCase()))];

      type Outcome =
        | { docId: string; kind: "added" | "alreadyInProject" | "notFound" }
        | { docId: string; kind: "failed"; code: string; message: string };

      // One lookup for existence: `GET /api/docs?ids=` leaves out deleted and archived documents,
      // which `GET /api/docs/:id` does not (it still answers for a soft-deleted one).
      const live = await ctx.api.listDocsPage({ ids: docIds, limit: docIds.length });
      const liveIds = new Set(live.docs.map((d) => d.id.toLowerCase()));

      const outcomes = await mapLimit(docIds, ADD_CONCURRENCY, async (docId): Promise<Outcome> => {
        if (!liveIds.has(docId)) return { docId, kind: "notFound" };
        try {
          const doc = await ctx.api.getDoc(docId);
          if (doc.projectIds.includes(project.id)) return { docId, kind: "alreadyInProject" };
          const { doc: after } = await ctx.api.patchDoc(docId, { addProjectId: project.id });
          if (!after.projectIds.includes(project.id)) {
            return { docId, kind: "failed", code: "upstream", message: "The API accepted the change but the document is not in the project." };
          }
          return { docId, kind: "added" };
        } catch (err) {
          if (isToolError(err) && err.code === "not_found") return { docId, kind: "notFound" };
          if (isCallerWideError(err)) throw err;
          return {
            docId,
            kind: "failed",
            code: isToolError(err) ? err.code : "upstream",
            message: err instanceof Error ? err.message : "Unexpected error.",
          };
        }
      });

      const ids = (kind: Outcome["kind"]) => outcomes.filter((o) => o.kind === kind).map((o) => o.docId);
      const failed = outcomes.flatMap((o) => (o.kind === "failed" ? [{ docId: o.docId, code: o.code, message: o.message }] : []));
      const added = ids("added");
      return {
        project: { projectId: project.id, slug: project.slug, name: untrustedOrNull(project.name, "document", UNTRUSTED_LIMITS.short) },
        added,
        alreadyInProject: ids("alreadyInProject"),
        notFound: ids("notFound"),
        ...(failed.length ? { failed } : {}),
        ...(added.length && project.shareEnabled !== false && project.shareId
          ? { publicUrl: ctx.api.projectPublicUrl(project.shareId), publicPageNote: "The project's public page is on: added documents with their link on are listed there." }
          : {}),
      };
    }),
  );
}

/** Register `lnkdrp_remove_doc_from_project`. */
export function registerRemoveDocFromProjectTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_remove_doc_from_project",
    {
      title: "Remove document from project",
      description:
        "Take one document out of a project. Only the membership goes: the document, its share links, their analytics and " +
        "its other projects are untouched, so this is not a delete and needs no confirmation. The document also stops being " +
        "listed on the project's public page. Returns removed: false with wasInProject: false when it was not in the project. " +
        "To delete the document itself use lnkdrp_delete_doc. " +
        SAFETY_TAIL,
      inputSchema: {
        projectId: projectIdSchema,
        projectSlug: projectSlugSchema,
        docId: docIdSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async (args) => {
      const { project } = await loadProject(ctx.api, args);
      const doc = await ctx.api.getDoc(args.docId);
      const projectRef = { projectId: project.id, slug: project.slug, name: untrustedOrNull(project.name, "document", UNTRUSTED_LIMITS.short) };
      if (!doc.projectIds.includes(project.id)) {
        return { project: projectRef, docId: doc.id, removed: false, wasInProject: false };
      }
      const { doc: after } = await ctx.api.patchDoc(doc.id, { removeProjectId: project.id });
      if (after.projectIds.includes(project.id)) {
        throw new ToolError("upstream", "The API accepted the change but the document is still in the project.");
      }
      return { project: projectRef, docId: doc.id, removed: true, wasInProject: true, remainingProjectIds: after.projectIds };
    }),
  );
}

/** Register `lnkdrp_update_project`. */
export function registerUpdateProjectTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_update_project",
    {
      title: "Update project",
      description:
        "Rename a project, change its description, or turn its public page on or off (publicPageEnabled). At least one is " +
        "required; anything not passed is kept. Renaming keeps the slug and every URL as they were. Turning the public page " +
        "off makes publicUrl answer 'not found' at once without touching the documents' own links; turning it on lists the " +
        "project's documents whose links are on. A name another project already uses is a validation error. " +
        SAFETY_TAIL,
      inputSchema: {
        projectId: projectIdSchema,
        projectSlug: projectSlugSchema,
        name: projectNameSchema.optional(),
        description: projectDescriptionSchema.optional().describe("New description; an empty string clears it. Shown on the public page."),
        publicPageEnabled: z.boolean().optional().describe("Whether the project's public page (publicUrl) resolves."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async (args) => {
      if (args.name === undefined && args.description === undefined && args.publicPageEnabled === undefined) {
        throw new ToolError("validation", "Pass at least one of name, description, publicPageEnabled.");
      }
      const { project, total } = await loadProject(ctx.api, args);
      let updated: ApiProject;
      try {
        updated =
          args.name === undefined && args.description === undefined
            ? await ctx.api.updateProject(project.id, { shareEnabled: args.publicPageEnabled as boolean })
            : // The route rewrites name, description and autoAddFiles together, so send the current
              // value of whatever the caller did not change.
              await ctx.api.updateProject(project.id, {
                name: args.name ?? project.name,
                description: args.description ?? project.description,
                autoAddFiles: project.autoAddFiles,
                ...(args.publicPageEnabled !== undefined ? { shareEnabled: args.publicPageEnabled } : {}),
              });
      } catch (err) {
        if (isToolError(err) && err.status === 409) {
          throw new ToolError("validation", "Another project in this workspace already has that name.", { status: 409, details: { name: args.name } });
        }
        throw err;
      }
      return { project: projectView(ctx.api, await withListedMeta(ctx.api, { ...updated, docCount: updated.docCount ?? total })) };
    }),
  );
}

/** Register `lnkdrp_delete_project`. */
export function registerDeleteProjectTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_delete_project",
    {
      title: "Delete project",
      description:
        "Delete a project permanently. Its documents are NOT deleted: they stay in the workspace with their links and " +
        "analytics and simply leave this project. The project's public page stops resolving and the project cannot be " +
        "restored from the app. On Free it frees the project slot. To take out only some documents use " +
        "lnkdrp_remove_doc_from_project. " +
        "DESTRUCTIVE: this tool confirms with the human before acting. If the client supports it, the user is shown the " +
        "project, how many documents it holds and whether its public page is live, and a yes/no prompt. If not, the call " +
        "fails with requiresConfirmation and a preview in details - show that preview to the user, ask them, and call again " +
        "with confirm: true only if they say yes. " +
        DISMISSED_PROMPT_NOTE +
        "A preview with severity 'high' means the project has a live public page " +
        "listing documents; do not confirm that on your own judgement. " +
        SAFETY_TAIL,
      inputSchema: { projectId: projectIdSchema, projectSlug: projectSlugSchema, confirm: confirmSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async (args) => {
      const { project, total } = await loadProject(ctx.api, args);
      const publicLive = project.shareEnabled !== false && Boolean(project.shareId);
      const publicUrl = project.shareId ? ctx.api.projectPublicUrl(project.shareId) : null;
      await requireHumanConfirmation(
        server,
        {
          headline: `Delete the project "${project.name || "Untitled project"}"`,
          facts: [
            total > 0
              ? `${total} document${total === 1 ? " leaves" : "s leave"} the project; the documents, their links and analytics are kept`
              : "The project has no documents",
            publicLive && publicUrl ? `Its public page ${publicUrl} stops resolving` : "Its public page is already off",
            "The project itself cannot be restored from the app",
          ],
          severity: publicLive && total > 0 ? "high" : "low",
          reversible: false,
        },
        args,
      );
      await ctx.api.deleteProject(project.id);
      return { ok: true, deleted: { projectId: project.id, slug: project.slug, documentsDetached: total } };
    }),
  );
}
