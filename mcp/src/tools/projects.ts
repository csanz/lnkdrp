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

import type { ApiClient, ApiProject, ApiProjectLink } from "../api";
import { requireHumanConfirmation, severityFromTraffic } from "../confirm";
import type { ToolContext } from "../context";
import { handleTool, isToolError, ToolError } from "../errors";
import { fingerprintArgs, IdempotencyStore } from "../idempotency";
import { UNTRUSTED_LIMITS, untrustedOrNull } from "../untrusted";
import { DISMISSED_PROMPT_NOTE, docIdSchema, existsUnlessNotFound, OBJECT_ID_RE, SAFETY_TAIL } from "./shared";

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

/**
 * The link `/p/:shareId` addresses, when the caller has the project's links to hand.
 *
 * `Project.shareEnabled` means "some link of this project is active" and `Project.shareId` points
 * at the default link whatever state that link is in: `syncProjectShareState`
 * (src/lib/share/projectLinks.ts) writes both and never consults the default link's own switch.
 * Disable the default link while one sibling link is live and the pair still reads "page on, here
 * is the URL" while that URL answers "not found", because `/p/:shareId` resolves the link the slug
 * names and refuses a disabled or expired one.
 *
 * So judge the link the URL actually addresses, not the project's two summary fields. A list we
 * could not read, and a default link not materialised yet (the lazy one, which serves fine),
 * both leave the old answer alone: this narrows a URL, it never invents one.
 */
function addressedLink(p: ApiProject, links: ApiProjectLink[] | null | undefined): ApiProjectLink | null {
  if (!links || !p.shareId) return null;
  return links.find((l) => l.shareId === p.shareId) ?? null;
}

/**
 * The project fields every tool returns. Names and descriptions are the workspace's own text.
 *
 * `publicUrl` is only ever a URL that resolves. It used to be `shareEnabled && shareId`, so an
 * agent that disabled the default link of a project with other live links was told nothing, and
 * every later read repeated `publicPageEnabled: true` beside a `/p/` URL that 404s: a lying read,
 * against this tool's own contract that publicUrl is null while the page is off, and durable for
 * whichever agent came next. Pass `links` wherever we have them and the dead URL becomes null plus
 * `publicUrlNote` saying which link went down and how to bring it back.
 */
function projectView(api: ApiClient, p: ApiProject, extra: { docCount?: number | null; links?: ApiProjectLink[] | null } = {}) {
  const docCount = extra.docCount !== undefined ? extra.docCount : p.docCount;
  const addressed = addressedLink(p, extra.links);
  // Only when we read the link and it refuses: unknown stays as it was.
  const urlIsDead = addressed !== null && !addressed.active;
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
          publicUrl: p.shareEnabled && p.shareId && !urlIsDead ? api.projectPublicUrl(p.shareId) : null,
          // Reachable only with shareEnabled true: if this were the project's last active link,
          // shareEnabled would be false and publicUrl null for that reason instead. So the page
          // being on and its address being dead really are both true here, and saying only the
          // first half is what sent agents back to a 404.
          ...(urlIsDead && p.shareEnabled && addressed
            ? {
                publicUrlNote:
                  `publicUrl is null because the link that address belongs to (/p/${addressed.shareId}${addressed.isDefault ? ", this project's default link" : ""}) is ` +
                  `${addressed.status}, so it answers "not found". It is the URL earlier recipients were sent. publicPageEnabled stays true because other ` +
                  "links of this project are still live: lnkdrp_list_project_links shows them and their own URLs, and " +
                  "lnkdrp_update_project_link { enabled: true } on that link brings the original address back.",
              }
            : {}),
        }
      : {}),
    createdDate: p.createdDate,
    updatedDate: p.updatedDate,
  };
}

/**
 * This project's links, or null when they cannot be read.
 *
 * Best-effort on purpose: the links are here to stop `projectView` publishing a URL that 404s, and
 * a listing that fails is a reason to answer as we always did, never a reason to fail the project
 * read the human asked for.
 */
async function readProjectLinks(api: ApiClient, projectId: string): Promise<ApiProjectLink[] | null> {
  return api.listProjectLinks(projectId).catch(() => null);
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
          .describe(
            "Caller-chosen key (1-128 chars). Reusing it within 24h returns the same project instead of creating another, " +
              "marked replayed: true so you can tell a retry from a second project; the same key with different arguments is refused.",
          ),
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
        // A project deleted between the two calls is not a project to hand back — replaying it
        // returned publicPageEnabled: true and a /p/ URL that resolves to nothing.
        stillExists: (cached) => existsUnlessNotFound(() => ctx.api.getProjectDocs(cached.project.id, { limit: 1 })),
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
        "docCount, appUrl, publicPageEnabled and publicUrl. publicUrl is a URL that resolves or it is null: null while the " +
        "public page is off, and also null when the page is on through other links but the link that address belongs to has " +
        "been disabled or has expired, in which case publicUrlNote says so and lnkdrp_list_project_links has the URLs that " +
        "do work. Documents: docId, shareId, " +
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
      // The links come along because publicUrl is only true if the link it addresses is live.
      const [projectTags, docTags, links] = await Promise.all([
        ctx.api.tagsForTarget({ targetKind: "project", targetId: res.project.id }).catch(() => []),
        ctx.api.tagsForTargets({ targetKind: "doc", ids: res.docs.map((d) => d.id) }).catch(() => new Map()),
        readProjectLinks(ctx.api, res.project.id),
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
            { links },
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
      // Same question projectView asks, and only asked when we are about to answer it: the page can
      // be on through other links while `/p/<shareId>` is disabled, and a URL the human is told to
      // send has to be one that opens. A listing we cannot read says what it always said.
      const willPublish = added.length > 0 && project.shareEnabled !== false && Boolean(project.shareId);
      const addressed = willPublish ? addressedLink(project, await readProjectLinks(ctx.api, project.id)) : null;
      const addressDead = addressed !== null && !addressed.active;
      return {
        project: { projectId: project.id, slug: project.slug, name: untrustedOrNull(project.name, "document", UNTRUSTED_LIMITS.short) },
        added,
        alreadyInProject: ids("alreadyInProject"),
        notFound: ids("notFound"),
        ...(failed.length ? { failed } : {}),
        ...(willPublish && !addressDead
          ? { publicUrl: ctx.api.projectPublicUrl(project.shareId as string), publicPageNote: "The project's public page is on: added documents with their link on are listed there." }
          : {}),
        ...(willPublish && addressDead && addressed
          ? {
              publicPageNote:
                `The project's public page is on and lists the added documents whose link is on, but /p/${addressed.shareId}` +
                `${addressed.isDefault ? ", this project's default link and the address earlier recipients hold," : ""} is ${addressed.status}, so that URL ` +
                "answers \"not found\". lnkdrp_list_project_links shows the links that do resolve.",
            }
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
      // After the write, not before: `publicPageEnabled: true` restores the links the page switch
      // had taken down, and this result is the read of record for the agent that just wrote.
      const links = await readProjectLinks(ctx.api, project.id);
      return { project: projectView(ctx.api, await withListedMeta(ctx.api, { ...updated, docCount: updated.docCount ?? total }), { links }) };
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
        "A preview with severity 'high' means recipients have already opened one of its links, or more than one live " +
        "link stops resolving; do not confirm that on your own judgement. " +
        SAFETY_TAIL,
      inputSchema: { projectId: projectIdSchema, projectSlug: projectSlugSchema, confirm: confirmSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async (args) => {
      const { project, total } = await loadProject(ctx.api, args);
      const publicLive = project.shareEnabled !== false && Boolean(project.shareId);
      /**
       * Severity from traffic, like every other destructive tool.
       *
       * It used to be `publicLive && total > 0` — "the page is on and it is not empty" — which is
       * not a fact about anyone losing anything. requireHumanConfirmation then printed its
       * high-severity sentence ("recipients have opened this, or more than one live link stops
       * resolving") above a facts list saying the project was made minutes ago, had one document
       * and zero views: neither disjunct true, contradicted by the evidence directly beneath it.
       * The traffic reading can fail (a link listing that 404s or times out), and the safe default
       * for a confirmation prompt is the louder one, so an unreadable listing stays "high".
       */
      const links = await ctx.api.listProjectLinks(project.id).catch(() => null);
      /**
       * Name the address only while it resolves.
       *
       * `/p/<shareId>` is dead whenever the link that slug names is disabled or expired, even
       * though the project still reads "public page on" through its other links. Printing it in a
       * confirmation prompt had the human picture recipients losing a page that had already
       * stopped answering them, and hid the links they really are about to lose.
       */
      const addressed = addressedLink(project, links);
      const publicUrl = project.shareId && !(addressed && !addressed.active) ? ctx.api.projectPublicUrl(project.shareId) : null;
      const liveLinks = links ? links.filter((l) => l.active).length : 0;
      const severity = links
        ? severityFromTraffic({
            recipientViews: links.reduce((n, l) => n + l.viewCount, 0),
            activeLinks: links.filter((l) => l.enabled && l.active).length,
          })
        : "high";
      await requireHumanConfirmation(
        server,
        {
          headline: `Delete the project "${project.name || "Untitled project"}"`,
          facts: [
            total > 0
              ? `${total} document${total === 1 ? " leaves" : "s leave"} the project; the documents, their links and analytics are kept`
              : "The project has no documents",
            publicLive && publicUrl
              ? `Its public page ${publicUrl} stops resolving`
              : publicLive && liveLinks > 0
                ? `Its ${liveLinks} live share ${liveLinks === 1 ? "link stops" : "links stop"} resolving (the /p/ address the project reports is already ${addressed?.status ?? "off"})`
                : "Its public page is already off",
            "The project itself cannot be restored from the app",
          ],
          severity,
          reversible: false,
        },
        args,
      );
      await ctx.api.deleteProject(project.id);
      return { ok: true, deleted: { projectId: project.id, slug: project.slug, documentsDetached: total } };
    }),
  );
}
