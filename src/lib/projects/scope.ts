/**
 * The one definition of "a project that counts" for a workspace.
 *
 * The plan check and the project list each had their own copy of this filter, and they drifted: a
 * workspace showing one project was refused a second with "used: 2, max: 1" (2026-09-18), so the
 * cap blocked a slot the owner could not see. Both now build their query here — if a row is hidden
 * from the list it is not counted either, and if it is counted the owner can find it.
 *
 * Request repos are not projects in this sense: they are a separate feature with their own list,
 * and they are recognised either by `isRequest` or by carrying an upload token.
 */
import type { Types } from "mongoose";

/** Mongo conditions for the workspace's real, live projects. */
export function liveProjectFilter(orgId: Types.ObjectId): Record<string, unknown> {
  return {
    orgId,
    isDeleted: { $ne: true },
    $and: [
      { $or: [{ isRequest: { $exists: false } }, { isRequest: { $ne: true } }] },
      { $or: [{ requestUploadToken: { $exists: false } }, { requestUploadToken: null }, { requestUploadToken: "" }] },
    ],
  };
}
