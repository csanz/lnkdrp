/**
 * Bring `ShareLink`'s denormalized counters back in line with the analytics rows they summarise.
 *
 * `viewCount`, `downloadCount` and `lastViewedAt` are incremented as traffic arrives, and a counter
 * and a row count drift. They have, twice, in ways nobody noticed until two numbers sat side by
 * side on one screen:
 *
 * - the owner-preview pass reclassified rows the counters had already counted, so `/links` reported
 *   4 views for a link whose metrics page said 3;
 * - the claim-link download route touched the link but wrote no row, so `downloadCount` ran ahead
 *   and the link's "Last viewed" pointed at a moment no one had viewed anything.
 *
 * Every read path now recomputes from the rows, so the stored counters are a fallback rather than
 * a source of truth — but a stored number that contradicts the page beside it is still a bug
 * waiting to be found by a user instead of by a job. This runs nightly (`/api/cron/analytics-
 * reconcile`) and after any maintenance pass that reclassifies rows.
 *
 * Two queries regardless of workspace size: one aggregation over the analytics rows grouped by
 * slug, one scan of the links. Repairs are idempotent — a second run reports zero.
 */
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { PROJECT_LINK_FILTER, ShareLinkModel } from "@/lib/models/ShareLink";
import { ShareViewModel } from "@/lib/models/ShareView";
import { projectLinkStatsByShareId } from "@/lib/share/projectLinks";

/**
 * How far a link's stored `lastViewedAt` may sit from the rows before it counts as drift.
 *
 * The link and the row are stamped by two statements milliseconds apart, so exact comparison
 * reports drift on every healthy link that has just been viewed — and a job that rewrites healthy
 * rows on every run never converges and teaches everyone to ignore its output.
 */
export const LAST_VIEWED_TOLERANCE_MS = 2000;

export type CounterDrift = {
  shareId: string;
  label: string | null;
  viewCount: { stored: number; actual: number } | null;
  downloadCount: { stored: number; actual: number } | null;
  lastViewedAt: { stored: string | null; actual: string | null } | null;
};

export type ReconcileResult = {
  linksChecked: number;
  linksReconciled: number;
  dryRun: boolean;
  /** A sample of what was out of step, for the cron health record. Capped so the row stays small. */
  drift: CounterDrift[];
};

/** The recomputed truth for one slug. */
type Truth = { viewCount: number; downloadCount: number; lastViewedAt: Date | null };

const EMPTY: Truth = { viewCount: 0, downloadCount: 0, lastViewedAt: null };

function sameInstant(a: Date | null, b: Date | null): boolean {
  if (!a || !b) return a === b || (!a && !b);
  return Math.abs(a.getTime() - b.getTime()) <= LAST_VIEWED_TOLERANCE_MS;
}

export async function reconcileShareLinkCounters(
  opts: { orgId?: string | Types.ObjectId | null; dryRun?: boolean; driftSampleLimit?: number } = {},
): Promise<ReconcileResult> {
  await connectMongo();
  const dryRun = Boolean(opts.dryRun);
  const sampleLimit = Math.max(0, opts.driftSampleLimit ?? 25);
  const orgFilter = opts.orgId ? { orgId: new Types.ObjectId(String(opts.orgId)) } : {};

  // Project links are counted by a different rule and are recomputed separately below: their rows
  // are one per (viewer, document), so the row count this pipeline produces is not the recipient
  // count `viewCount` means everywhere else. Without the split this job faithfully wrote the wrong
  // quantity back onto every project link on every nightly run, undoing the read paths' agreement.
  const projectSlugs = (await ShareLinkModel.find({ ...orgFilter, ...PROJECT_LINK_FILTER }).distinct(
    "shareId",
  )) as unknown as string[];

  // Recipients only, and `lastViewedAt` before `updatedDate` — the same two rules every read path
  // applies, so this job and the metrics page cannot disagree about what a link's traffic is.
  const rows = (await ShareViewModel.aggregate([
    { $match: { ...orgFilter, isOwnerPreview: { $ne: true }, ...(projectSlugs.length ? { shareId: { $nin: projectSlugs } } : {}) } },
    {
      $group: {
        _id: "$shareId",
        viewCount: { $sum: 1 },
        downloadCount: { $sum: { $ifNull: ["$downloads", 0] } },
        lastViewedAt: { $max: { $ifNull: ["$lastViewedAt", "$updatedDate"] } },
      },
    },
  ])) as Array<{ _id: string; viewCount?: number; downloadCount?: number; lastViewedAt?: Date | null }>;

  const bySlug = new Map<string, Truth>();
  for (const r of rows) {
    if (typeof r._id !== "string" || !r._id) continue;
    bySlug.set(r._id, {
      viewCount: typeof r.viewCount === "number" && Number.isFinite(r.viewCount) ? r.viewCount : 0,
      downloadCount: typeof r.downloadCount === "number" && Number.isFinite(r.downloadCount) ? r.downloadCount : 0,
      lastViewedAt: r.lastViewedAt ? new Date(r.lastViewedAt) : null,
    });
  }

  // The project half, from the one function the project read paths already share, so "what a
  // project link's viewCount is" has exactly one definition in the codebase.
  if (projectSlugs.length) {
    const projectTruth = await projectLinkStatsByShareId(projectSlugs);
    for (const [shareId, stats] of projectTruth) {
      bySlug.set(shareId, {
        viewCount: stats.viewCount,
        downloadCount: stats.downloadCount,
        lastViewedAt: stats.lastViewedAt,
      });
    }
  }

  const links = (await ShareLinkModel.find(orgFilter)
    .select({ _id: 1, shareId: 1, label: 1, viewCount: 1, downloadCount: 1, lastViewedAt: 1 })
    .lean()) as unknown as Array<{
    _id: Types.ObjectId;
    shareId: string;
    label?: string | null;
    viewCount?: number | null;
    downloadCount?: number | null;
    lastViewedAt?: Date | null;
  }>;

  const drift: CounterDrift[] = [];
  let linksReconciled = 0;

  for (const link of links) {
    const truth = bySlug.get(link.shareId) ?? EMPTY;
    const storedViews = link.viewCount ?? 0;
    const storedDownloads = link.downloadCount ?? 0;
    const storedLast = link.lastViewedAt ? new Date(link.lastViewedAt) : null;

    const viewsOff = storedViews !== truth.viewCount;
    const downloadsOff = storedDownloads !== truth.downloadCount;
    const lastOff = !sameInstant(storedLast, truth.lastViewedAt);
    if (!viewsOff && !downloadsOff && !lastOff) continue;

    linksReconciled += 1;
    if (drift.length < sampleLimit) {
      drift.push({
        shareId: link.shareId,
        label: link.label ?? null,
        viewCount: viewsOff ? { stored: storedViews, actual: truth.viewCount } : null,
        downloadCount: downloadsOff ? { stored: storedDownloads, actual: truth.downloadCount } : null,
        lastViewedAt: lastOff
          ? { stored: storedLast ? storedLast.toISOString() : null, actual: truth.lastViewedAt ? truth.lastViewedAt.toISOString() : null }
          : null,
      });
    }
    if (dryRun) continue;

    // `timestamps: false`: this is maintenance. Mongoose stamps `updatedDate` on any update query,
    // and `updatedDate` is a fallback for "last activity" elsewhere — a repair pass must not look
    // like traffic.
    await ShareLinkModel.updateOne(
      { _id: link._id },
      { $set: { viewCount: truth.viewCount, downloadCount: truth.downloadCount, lastViewedAt: truth.lastViewedAt } },
      { timestamps: false },
    );
  }

  return { linksChecked: links.length, linksReconciled, dryRun, drift };
}
