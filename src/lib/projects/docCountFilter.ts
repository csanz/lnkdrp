/**
 * What `Project.docCount` counts: the documents of the project's workspace that are in the project
 * by any of the three membership fields and are neither archived nor deleted.
 *
 * One definition, shared by the Doc model hooks that keep the counter in sync (they recompute it
 * from this filter after every membership or state change, so two writes that race on the same
 * document cannot drift the count the way paired increments did; code review 2026-09-23) and by
 * anything that wants to check the counter against the truth.
 */
import { Types } from "mongoose";

/** Mongo filter for the documents `Project.docCount` counts on `projectId` within `orgId`. */
export function projectDocCountFilter(orgId: Types.ObjectId, projectId: Types.ObjectId): Record<string, unknown> {
  return {
    orgId,
    isDeleted: { $ne: true },
    isArchived: { $ne: true },
    $or: [{ primaryProjectId: projectId }, { projectId }, { projectIds: projectId }],
  };
}
