/**
 * Backfill: give every analytics row its link (`shareLinkId`) and its workspace (`orgId`).
 *
 * `shareLinkId` was only ever written inside `$setOnInsert`, so it landed on brand-new rows and
 * nothing else: a row created before its link was materialised — which is every row that predates
 * docs/prds/lnkdrp-multi-links.md — kept a null join handle forever, because a returning viewer
 * matches the existing row and never inserts again. The field is therefore a trap: the first query
 * written as `{ shareLinkId: link._id }` returns a fraction of the truth and looks plausible.
 *
 * `orgId` is new on both collections (denormalized tenancy, so workspace-level analytics is an
 * indexed range scan instead of a `$lookup` into `docs`) and needs the same pass.
 *
 * `lastViewedAt` (`ShareView`) is seeded here too, from `createdDate`. Every write in this script
 * runs with `timestamps: false`: Mongoose stamps `updatedDate` on any update query, and the first
 * run of this script — before that option was passed — moved every row's `updatedDate` to the same
 * instant, which is what the links table was reporting as "Last viewed". The read path now prefers
 * `ShareView.lastViewedAt`, written only by the view ingest paths, so no maintenance pass can ever
 * rewrite that column again.
 *
 * `shareId` is the mapping: `sharelinks.shareId` is unique and `shareviews.shareId` /
 * `sharevisits.shareId` are indexed, so this is one index scan per link.
 *
 * Usage:
 * - Dry run (default):  npx tsx --env-file=.env.local scripts/sharelinks-analytics-backfill.ts --dry-run
 * - Apply:              npx tsx --env-file=.env.local scripts/sharelinks-analytics-backfill.ts
 *
 * Optional:
 * - --org <orgId>       restrict to one workspace's links
 *
 * Idempotent: every filter requires the field to be missing or null, so a second run reports zero
 * and writes nothing. Safe to run while the app is serving — the write paths now `$set` both
 * fields on every touch, so live rows self-heal and this only catches the ones nobody visits.
 */
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { ShareLinkModel } from "@/lib/models/ShareLink";
import { ShareViewModel } from "@/lib/models/ShareView";
import { ShareVisitModel } from "@/lib/models/ShareVisit";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { reconcileShareLinkCounters } from "@/lib/analytics/reconcileLinkCounters";

type LinkRow = {
  _id: Types.ObjectId;
  shareId: string;
  docId: Types.ObjectId;
  orgId?: Types.ObjectId | null;
};

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  const v = process.argv[idx + 1];
  return typeof v === "string" && !v.startsWith("--") ? v : null;
}

function log(line: string): void {
  // eslint-disable-next-line no-console
  console.log(line);
}

/** Missing or explicitly null — the two shapes an un-backfilled field can have. */
const MISSING = (field: string) => ({ $or: [{ [field]: null }, { [field]: { $exists: false } }] });

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const orgRaw = argValue("--org");
  if (orgRaw && !Types.ObjectId.isValid(orgRaw)) throw new Error(`--org must be an ObjectId, got ${orgRaw}`);

  await connectMongo();

  const links = (await ShareLinkModel.find(orgRaw ? { orgId: new Types.ObjectId(orgRaw) } : {})
    .select({ _id: 1, shareId: 1, docId: 1, orgId: 1 })
    .lean()) as unknown as LinkRow[];

  // A link row may predate `orgId` (or have been created from a doc that had none); the document
  // is the authority, so fill the gaps in one query instead of one per link.
  const missingOrg = links.filter((l) => !l.orgId).map((l) => l.docId);
  const docOrgById = new Map<string, string>();
  if (missingOrg.length) {
    const docs = (await DocModel.find({ _id: { $in: missingOrg } })
      .select({ _id: 1, orgId: 1 })
      .lean()) as unknown as Array<{ _id: Types.ObjectId; orgId?: Types.ObjectId | null }>;
    for (const d of docs) if (d.orgId) docOrgById.set(String(d._id), String(d.orgId));
  }

  // The document's owner, for every link — a legacy doc has no workspace, so `userId` is the only
  // handle on "the owning side" there, and an owner who has since left the workspace still is one.
  const docOwnerById = new Map<string, string>();
  if (links.length) {
    const ownerRows = (await DocModel.find({ _id: { $in: links.map((l) => l.docId) } })
      .select({ _id: 1, userId: 1 })
      .lean()) as unknown as Array<{ _id: Types.ObjectId; userId?: Types.ObjectId | null }>;
    for (const d of ownerRows) if (d.userId) docOwnerById.set(String(d._id), String(d.userId));
  }

  const before = {
    shareViewsMissingLink: await ShareViewModel.countDocuments(MISSING("shareLinkId")),
    shareViewsMissingOrg: await ShareViewModel.countDocuments(MISSING("orgId")),
    shareViewsMissingLastViewedAt: await ShareViewModel.countDocuments(MISSING("lastViewedAt")),
    shareVisitsMissingLink: await ShareVisitModel.countDocuments(MISSING("shareLinkId")),
    shareVisitsMissingOrg: await ShareVisitModel.countDocuments(MISSING("orgId")),
  };

  // Sanity, before writing anything: a row whose `docId` disagrees with its link's `docId` would
  // mean the `shareId` mapping is not the one the read paths assume, and this script would cement
  // the disagreement. Report it and refuse to touch those slugs.
  const linkByShareId = new Map<string, LinkRow>(links.map((l) => [l.shareId, l]));
  const mismatches: string[] = [];
  const distinctShareIds = (await ShareViewModel.distinct("shareId")) as unknown as string[];
  const orphanShareIds: string[] = [];
  for (const sid of distinctShareIds) {
    const link = linkByShareId.get(sid);
    if (!link) {
      if (!orgRaw) orphanShareIds.push(sid);
      continue;
    }
    const wrong = await ShareViewModel.countDocuments({ shareId: sid, docId: { $ne: link.docId } });
    if (wrong > 0) mismatches.push(`${sid}: ${wrong} shareview rows point at another docId`);
  }

  let viewsLinked = 0;
  let viewsOrged = 0;
  let visitsLinked = 0;
  let visitsOrged = 0;
  let skippedLinks = 0;
  let viewsLastViewedSeeded = 0;
  let viewsMarkedOwnerPreview = 0;
  let visitsMarkedOwnerPreview = 0;
  let linkCountersReconciled = 0;

  /**
   * Workspace members, by workspace — the owning side, whose own opens must not be counted as
   * recipient views (see `ShareView.isOwnerPreview`). Cached because a workspace usually owns many
   * links and the membership list does not change mid-run.
   */
  const membersByOrg = new Map<string, Types.ObjectId[]>();
  async function ownerSideUserIds(orgIdStr: string | null, docId: Types.ObjectId): Promise<Types.ObjectId[]> {
    const ids = new Map<string, Types.ObjectId>();
    // Legacy documents predate workspaces and carry only an owner `userId`.
    const ownerUserId = docOwnerById.get(String(docId)) ?? null;
    if (ownerUserId) ids.set(ownerUserId, new Types.ObjectId(ownerUserId));
    if (orgIdStr && Types.ObjectId.isValid(orgIdStr)) {
      let members = membersByOrg.get(orgIdStr);
      if (!members) {
        const rows = await OrgMembershipModel.find({ orgId: new Types.ObjectId(orgIdStr), isDeleted: { $ne: true } })
          .select({ userId: 1 })
          .lean();
        members = rows.map((r) => new Types.ObjectId(String((r as { userId: unknown }).userId)));
        membersByOrg.set(orgIdStr, members);
      }
      for (const m of members) ids.set(String(m), m);
    }
    return Array.from(ids.values());
  }

  for (const link of links) {
    if (mismatches.some((m) => m.startsWith(`${link.shareId}:`))) {
      skippedLinks += 1;
      continue;
    }
    const orgIdStr = link.orgId ? String(link.orgId) : docOrgById.get(String(link.docId)) ?? null;
    const orgId = orgIdStr ? new Types.ObjectId(orgIdStr) : null;

    const linkFilter = { shareId: link.shareId, ...MISSING("shareLinkId") };
    const orgFilter = { shareId: link.shareId, ...MISSING("orgId") };
    // Only signed-in rows can be classified: an owner who opened their own link in a logged-out
    // browser left a row indistinguishable from a recipient's, and guessing would delete real
    // traffic. The flag understates owner previews on historical data, which is the safe direction.
    const ownerSide = await ownerSideUserIds(orgIdStr, link.docId);
    const ownerPreviewFilter = ownerSide.length
      ? { shareId: link.shareId, viewerUserId: { $in: ownerSide }, isOwnerPreview: { $ne: true } }
      : null;

    if (dryRun) {
      viewsLinked += await ShareViewModel.countDocuments(linkFilter);
      visitsLinked += await ShareVisitModel.countDocuments(linkFilter);
      if (orgId) {
        viewsOrged += await ShareViewModel.countDocuments(orgFilter);
        visitsOrged += await ShareVisitModel.countDocuments(orgFilter);
      }
      viewsLastViewedSeeded += await ShareViewModel.countDocuments({ shareId: link.shareId, ...MISSING("lastViewedAt") });
      if (ownerPreviewFilter) {
        viewsMarkedOwnerPreview += await ShareViewModel.countDocuments(ownerPreviewFilter);
        visitsMarkedOwnerPreview += await ShareVisitModel.countDocuments(ownerPreviewFilter);
      }
      continue;
    }

    // `timestamps: false` on every write here: Mongoose stamps `updatedDate` on any update query,
    // and `updatedDate` used to be what "Last viewed" reported — so the first run of this script
    // rewrote the whole Last-viewed column of every links table to the instant it ran, burying the
    // real view times. The read path now prefers `ShareView.lastViewedAt` (written only by the
    // view ingest paths), and this pass must not touch either field.
    const v1 = await ShareViewModel.updateMany(linkFilter, { $set: { shareLinkId: link._id } }, { timestamps: false });
    viewsLinked += v1.modifiedCount ?? 0;
    const s1 = await ShareVisitModel.updateMany(linkFilter, { $set: { shareLinkId: link._id } }, { timestamps: false });
    visitsLinked += s1.modifiedCount ?? 0;
    if (orgId) {
      const v2 = await ShareViewModel.updateMany(orgFilter, { $set: { orgId } }, { timestamps: false });
      viewsOrged += v2.modifiedCount ?? 0;
      const s2 = await ShareVisitModel.updateMany(orgFilter, { $set: { orgId } }, { timestamps: false });
      visitsOrged += s2.modifiedCount ?? 0;
    }

    // Seed `lastViewedAt` from the only timestamp a maintenance write cannot move: `createdDate`
    // (when this viewer first opened the link). Deliberately NOT `updatedDate` — on any database a
    // previous run of this script has touched, `updatedDate` IS the corrupted value, so copying it
    // would cement "every link was viewed the instant the backfill ran". `createdDate` understates
    // a returning viewer's last visit, which is the safe direction; the row self-heals to the truth
    // on that viewer's next heartbeat.
    const seeded = await ShareViewModel.updateMany(
      { shareId: link.shareId, ...MISSING("lastViewedAt") },
      [{ $set: { lastViewedAt: "$createdDate" } }],
      { timestamps: false },
    );
    viewsLastViewedSeeded += seeded.modifiedCount ?? 0;

    if (ownerPreviewFilter) {
      const v3 = await ShareViewModel.updateMany(ownerPreviewFilter, { $set: { isOwnerPreview: true } }, { timestamps: false });
      viewsMarkedOwnerPreview += v3.modifiedCount ?? 0;
      const s3 = await ShareVisitModel.updateMany(ownerPreviewFilter, { $set: { isOwnerPreview: true } }, { timestamps: false });
      visitsMarkedOwnerPreview += s3.modifiedCount ?? 0;
    }

  }

  // The counters, once, from the module the nightly cron uses — not re-derived here. Flagging rows
  // as owner previews above changes what they count towards, and the counters were incremented when
  // those rows were written, so this pass must always follow that one. Duplicating the arithmetic is
  // how the two definitions drifted in the first place.
  const counters = await reconcileShareLinkCounters({ orgId: orgRaw ?? null, dryRun });
  linkCountersReconciled = counters.linksReconciled;

  const after = {
    shareViewsMissingLink: await ShareViewModel.countDocuments(MISSING("shareLinkId")),
    shareViewsMissingOrg: await ShareViewModel.countDocuments(MISSING("orgId")),
    shareViewsMissingLastViewedAt: await ShareViewModel.countDocuments(MISSING("lastViewedAt")),
    shareVisitsMissingLink: await ShareVisitModel.countDocuments(MISSING("shareLinkId")),
    shareVisitsMissingOrg: await ShareVisitModel.countDocuments(MISSING("orgId")),
  };

  log(
    JSON.stringify(
      {
        dryRun,
        links: links.length,
        before,
        updated: {
          viewsLinked,
          viewsOrged,
          visitsLinked,
          visitsOrged,
          viewsLastViewedSeeded,
          viewsMarkedOwnerPreview,
          visitsMarkedOwnerPreview,
          linkCountersReconciled,
        },
        after,
        skippedLinks,
        // Slugs with analytics rows but no `sharelinks` row: nothing can be attributed to a link
        // that does not exist. Run `scripts/sharelinks-backfill.ts` first, then this again.
        orphanShareIds,
        mismatches,
      },
      null,
      2,
    ),
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
