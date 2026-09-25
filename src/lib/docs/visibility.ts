/**
 * Contained documents (docs/prds/lnkdrp-project-home.md, decisions 3 to 6).
 *
 * A document with `visibility: "project"` lives only inside its primary project. Every
 * workspace-wide listing spreads `workspaceListableDocFilter()` into its Mongo filter so the
 * document is absent from the sidebar, `/api/docs`, search, tags, the dashboard, workspace
 * metrics and the MCP's list; the project's own listings do not use it. One helper, so a new
 * listing cannot forget the rule, and a source-contract test pins every listing to it.
 */
import { Types } from "mongoose";

import { DocModel } from "@/lib/models/Doc";

export type DocVisibility = "workspace" | "project";

/** Spread into any workspace-wide document filter. Documents without the field count as workspace. */
export function workspaceListableDocFilter(): { visibility: { $ne: "project" } } {
  return { visibility: { $ne: "project" } };
}

/** The `$expr`-free aggregate form of the same rule, for pipelines that `$match` on documents. */
export const WORKSPACE_LISTABLE_MATCH = { visibility: { $ne: "project" } } as const;

/** Ids of the workspace's contained documents: what the workspace feed leaves out (decision 5). */
export async function containedDocIds(orgId: Types.ObjectId | string): Promise<Types.ObjectId[]> {
  const rows = (await DocModel.find({ orgId: new Types.ObjectId(String(orgId)), visibility: "project", isDeleted: { $ne: true } })
    .select({ _id: 1 })
    .limit(5000)
    .lean()) as Array<{ _id: Types.ObjectId }>;
  return rows.map((r) => r._id);
}

/** Whether a document may be contained: it needs a home project to be contained in. */
export function canContain(doc: { primaryProjectId?: unknown; projectIds?: unknown[] }): boolean {
  if (doc.primaryProjectId) return true;
  return Array.isArray(doc.projectIds) && doc.projectIds.length === 1;
}
