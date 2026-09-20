/**
 * `lnkdrp_list_tags`, `lnkdrp_tag`, `lnkdrp_untag` — the workspace's own filing system.
 *
 * Tags exist for the case this product keeps running into: an agent that receives documents all
 * day ("here's the Series A deck", "here's the diligence index") and a human who later wants to
 * see everything to do with fundraising, across documents and projects. Filing is the part a human
 * stops doing after week two and an agent never stops doing, so it has to be reachable from here.
 *
 * `lnkdrp_tag` takes a *name*, not an id, and the API creates the tag if the workspace has no such
 * tag yet — one call, no race, and no "list the tags, then decide" dance in the agent. The name is
 * folded the same way everywhere ("Fundraising", "fundraising" and " FUNDRAISING " are one tag), so
 * an agent that types the obvious thing lands on the tag a person already made.
 *
 * Tagging changes nothing a recipient can see: a tag is private to the workspace, so none of these
 * needs a confirmation gate. Untagging is the one that removes something, and it is trivially
 * undone by tagging again, so it does not either.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ApiTag } from "../api";
import type { ToolContext } from "../context";
import { handleTool } from "../errors";
import { docIdSchema, SAFETY_TAIL } from "./shared";
import { tagSlug } from "../../../src/lib/tags/slug";

/**
 * What a tag looks like coming back out.
 *
 * Names are not wrapped as untrusted content, the same as project names: a tag is written by a
 * member of the workspace the agent is already acting for, not by a document or a viewer, and the
 * `untrusted` wrapper exists to mark text that came from outside that boundary.
 */
const tagView = (tags: ApiTag[]) =>
  tags.map((t) => ({
    tagId: t.id,
    name: t.name,
    slug: t.slug,
    color: t.color,
    ...(t.count === null ? {} : { taggedItems: t.count }),
  }));

const targetShape = {
  docId: docIdSchema.optional().describe("The document to tag. Give exactly one of docId or projectId."),
  projectId: z.string().trim().min(1).optional().describe("The project to tag. Give exactly one of docId or projectId."),
};

/** One target, never two, never none — the error says which, rather than guessing. */
function resolveTarget(args: { docId?: string | undefined; projectId?: string | undefined }): {
  targetKind: "doc" | "project";
  targetId: string;
} {
  const doc = (args.docId ?? "").trim();
  const project = (args.projectId ?? "").trim();
  if (doc && project) throw new Error("Give either docId or projectId, not both.");
  if (!doc && !project) throw new Error("Give a docId or a projectId to tag.");
  return doc ? { targetKind: "doc", targetId: doc } : { targetKind: "project", targetId: project };
}

/** Register `lnkdrp_list_tags`. */
export function registerListTagsTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_list_tags",
    {
      title: "List tags",
      description:
        "Every tag in the workspace, alphabetical, with how many documents and projects carry each. Read this before " +
        "tagging when you want to reuse the workspace's own words rather than inventing a near-duplicate: a workspace " +
        "with 'Fundraising' does not want 'fund raising' as well. Tags are private to the workspace and never shown to " +
        "recipients. " +
        SAFETY_TAIL,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async () => {
      const tags = await ctx.api.listTags();
      return { tags: tagView(tags), count: tags.length };
    }),
  );
}

/** Register `lnkdrp_tag`. */
export function registerTagTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_tag",
    {
      title: "Tag a document or project",
      description:
        "Put one or more tags on a document (docId) or a project (projectId). Tags are given by name and created if the " +
        "workspace has none by that name, so filing something takes one call. Names are matched loosely — case, accents " +
        "and punctuation are folded, so 'Fundraising', 'fundraising' and ' FUNDRAISING ' are the same tag and you will " +
        "not make a duplicate by typing it differently. Safe to repeat: a tag already on the item stays as it is. " +
        "Returns every tag on the item afterwards, and which names were newly created. " +
        SAFETY_TAIL,
      inputSchema: {
        ...targetShape,
        tags: z
          .array(z.string().trim().min(1).max(60))
          .min(1)
          .max(10)
          .describe("Tag names to add (1-10). Created if they do not exist yet."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async (args) => {
      const target = resolveTarget(args);
      const names = [...new Set(args.tags.map((t) => t.trim()).filter(Boolean))];
      const created: string[] = [];
      let tags: ApiTag[] = [];
      // One at a time rather than in a batch: the API's find-or-create is per name, and a partial
      // failure this way leaves the tags that did land rather than losing all of them.
      for (const name of names) {
        const result = await ctx.api.attachTag({ ...target, name });
        tags = result.tags;
        if (result.created) created.push(name);
      }
      return {
        [target.targetKind === "doc" ? "docId" : "projectId"]: target.targetId,
        tags: tagView(tags),
        createdTags: created,
      };
    }),
  );
}

/** Register `lnkdrp_untag`. */
export function registerUntagTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_untag",
    {
      title: "Remove a tag",
      description:
        "Take tags off a document (docId) or a project (projectId), by name. The tag itself stays in the workspace and " +
        "on everything else that carries it; only this item loses it. Safe to repeat: a tag that was not on the item is " +
        "reported in notTagged, not an error. Returns the tags left on the item. " +
        SAFETY_TAIL,
      inputSchema: {
        ...targetShape,
        tags: z.array(z.string().trim().min(1).max(60)).min(1).max(10).describe("Tag names to remove (1-10)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async (args) => {
      const target = resolveTarget(args);
      // Folded with the same function the server files tags under, because `lnkdrp_tag` promises
      // exactly that: "case, accents and punctuation are folded". Removing was only lowercasing, so
      // untagging "Serie A" from an item carrying "Série A" — or "fund raising" where the tag is
      // "fund-raising" — reported it in notTagged, which tells the agent the tag was not there when
      // it is. A tool that silently declines to do the one thing it was asked is worse than one
      // that refuses.
      const wanted = [...new Set(args.tags.map((t) => tagSlug(t)).filter(Boolean))];

      let tags = await ctx.api.tagsForTarget(target);
      const removed: string[] = [];
      const notTagged: string[] = [];
      for (const name of wanted) {
        // Both sides through the same fold: the stored slug IS the folded name, so comparing
        // against it is the whole match. The display name is folded too rather than compared raw,
        // for tags written before a slug existed.
        const match = tags.find((t) => t.slug === name || tagSlug(t.name) === name);
        if (!match) {
          notTagged.push(name);
          continue;
        }
        tags = await ctx.api.detachTag({ ...target, tagId: match.id });
        removed.push(match.name);
      }
      return {
        [target.targetKind === "doc" ? "docId" : "projectId"]: target.targetId,
        removed,
        notTagged,
        tags: tagView(tags),
      };
    }),
  );
}
