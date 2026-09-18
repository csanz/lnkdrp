/**
 * The document-scope rule, in one place: **a read through a project link is the project's view,
 * not the document's.**
 *
 * A recipient who opens a file inside a data room writes a `ShareView`/`ShareVisit` row carrying
 * that file's `docId` under the *project* link's slug (docs/METRICS.md, "Project links: how a
 * data-room visit is keyed"). So `{ docId }` on its own stopped meaning "this document's links" the
 * day project links shipped, and every document-scoped figure has to subtract those slugs or it
 * reports traffic the document's own metrics page does not show — and, because the label join is
 * `{docId, shareId}` and a project link's `docId` is null, renders it as "Deleted link".
 *
 * This module exists because that rule was learned by one surface at a time: the live metrics route
 * excluded project slugs while `rollupDocMetrics` (the dashboard card's snapshot) and
 * `Doc.numberOfViews` did not, so the card, the snapshot and the page each reported a different
 * number for the same document and QuickStats visibly flashed the larger one before swapping to the
 * smaller. Anything that counts `ShareView` rows *for a document* imports from here; the ingest
 * counterpart is the `projectTarget` guard on `Doc.numberOfViews`.
 *
 * The exclusion is derived from the rows themselves rather than from the document's current project
 * membership: a document removed from a project keeps the rows it earned inside it, and those must
 * stay excluded too.
 */
import { Types } from "mongoose";

import { PROJECT_LINK_FILTER, ShareLinkModel } from "@/lib/models/ShareLink";
import { ShareViewModel } from "@/lib/models/ShareView";
import { shareIdClause } from "./shareViewAggregates";

/**
 * The slugs these documents have traffic on that are **not** their own links — i.e. project links.
 *
 * Two bounded reads: the distinct slugs the documents have traffic on (a handful per document),
 * then which of those are project links. Passing several documents at once is deliberate — the
 * rollup runs over a batch and a project slug is a project slug for every document in it, so one
 * pair of queries answers for the whole batch.
 */
export async function projectLinkSlugsForDocs(docIds: ReadonlyArray<Types.ObjectId | string>): Promise<string[]> {
  const ids = docIds
    .map((id) => String(id))
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));
  if (!ids.length) return [];
  const trafficShareIds = (await ShareViewModel.distinct("shareId", {
    docId: ids.length === 1 ? ids[0] : { $in: ids },
  })) as unknown as string[];
  if (!trafficShareIds.length) return [];
  return (await ShareLinkModel.find({ shareId: { $in: trafficShareIds }, ...PROJECT_LINK_FILTER }).distinct(
    "shareId",
  )) as unknown as string[];
}

/**
 * {@link projectLinkSlugsForDocs} as the `$match` clause it is always spread into, beside the
 * excluded slugs themselves (a caller that has any of them knows its counters are contaminated by
 * pre-rule increments — see the `legacyViews` floor in the document metrics route).
 *
 * `$nin`, not an `$in` of the document's own slugs: traffic whose link was hard-deleted has no
 * `ShareLink` row at all and still belongs to the document — it is what `deletedLinkResidual`
 * exists to explain, and an `$in` would silently erase it.
 */
export async function docOnlyShareIdMatch(
  docIds: ReadonlyArray<Types.ObjectId | string>,
): Promise<{ foreignShareIds: string[]; match: Record<string, unknown> }> {
  const foreignShareIds = await projectLinkSlugsForDocs(docIds);
  return { foreignShareIds, match: shareIdClause({ except: foreignShareIds }) };
}

/**
 * Every project-link slug a **workspace** owns — the org-scoped form of
 * {@link projectLinkSlugsForDocs}, for a surface that already holds an `orgId` and would otherwise
 * have to ask "which slugs do these 600 documents have traffic on" first.
 *
 * One indexed read on `{ orgId, kind }` instead of a `distinct` over the workspace's whole view
 * collection, and the answer is a superset of what every document in the workspace needs: a slug
 * that is a project link is a project link for every document opened through it. Deliberately not
 * bounded by current project membership, for the reason the module header gives.
 */
export async function projectLinkSlugsForOrg(orgId: Types.ObjectId | string): Promise<string[]> {
  const id = Types.ObjectId.isValid(String(orgId)) ? new Types.ObjectId(String(orgId)) : null;
  if (!id) return [];
  return (await ShareLinkModel.find({ orgId: id, ...PROJECT_LINK_FILTER }).distinct("shareId")) as unknown as string[];
}
