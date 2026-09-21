/**
 * The purge: what actually gets destroyed 30 days after someone asks to delete their account.
 *
 * Written as a plan first, then executed, so the job can run as a dry run against real data and
 * report exactly what it would remove. That is the only honest way to test a destructive job.
 *
 * Scope: the person, the workspaces they owned alone, and everything inside those workspaces —
 * documents, uploads and their stored files, share links and the analytics rows about them, credit
 * rows, API keys, memberships, activity. Workspaces with other members survive: the leaver's
 * membership is dropped and the team keeps its documents. Shared workspace rows (a teammate's
 * document) are never touched.
 *
 * Blobs are deleted before the rows that point at them: a row without its file is a broken record,
 * but a file without its row is unreachable garbage nobody can find.
 */
import { Types } from "mongoose";
import { del as blobDel } from "@vercel/blob";

import { connectMongo } from "@/lib/mongodb";
import { UserModel } from "@/lib/models/User";
import { OrgModel } from "@/lib/models/Org";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { DocModel } from "@/lib/models/Doc";
import { UploadModel } from "@/lib/models/Upload";
import { ShareLinkModel } from "@/lib/models/ShareLink";
import { ShareViewModel } from "@/lib/models/ShareView";
import { ShareVisitModel } from "@/lib/models/ShareVisit";
import { ActivityEventModel } from "@/lib/models/ActivityEvent";
import { ApiKeyModel } from "@/lib/models/ApiKey";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { WorkspaceCreditBalanceModel } from "@/lib/models/WorkspaceCreditBalance";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { CreditPurchaseModel } from "@/lib/models/CreditPurchase";
import { DocChangeModel } from "@/lib/models/DocChange";
import { DocPageTimingModel } from "@/lib/models/DocPageTiming";
import { ErrorEventModel } from "@/lib/models/ErrorEvent";
import { NotificationEmailCursorModel } from "@/lib/models/NotificationEmailCursor";
import { NotificationQueueModel } from "@/lib/models/NotificationQueue";
import { OrgInviteModel } from "@/lib/models/OrgInvite";
import { ProjectModel } from "@/lib/models/Project";
import { ProjectLinkViewModel } from "@/lib/models/ProjectLinkView";
import { ShareViewerEmailModel } from "@/lib/models/ShareViewerEmail";
import { StarredDocModel } from "@/lib/models/StarredDoc";
import { TagModel } from "@/lib/models/Tag";
import { TagAssignmentModel } from "@/lib/models/TagAssignment";
import { UsageAggCycleModel } from "@/lib/models/UsageAggCycle";
import { UsageAggDailyModel } from "@/lib/models/UsageAggDaily";

export type PurgePlan = {
  userId: string;
  email: string | null;
  requestedAt: string | null;
  purgeAfter: string | null;
  /** Workspaces the person owned alone: these and their contents go. */
  soloOrgIds: string[];
  /** Workspaces with other members: only the leaver's membership goes. */
  sharedOrgIds: string[];
  counts: {
    docs: number;
    uploads: number;
    blobs: number;
    shareLinks: number;
    shareViews: number;
    activity: number;
    apiKeys: number;
    creditRows: number;
  };
};

/**
 * Every stored file an upload points at. Duplicates are fine; deletion is idempotent.
 *
 * `slideNodes` is the reason this is not a four-key loop. A processed PDF stores one image and one
 * thumbnail **per page**, and those are the overwhelming majority of the bytes an account holds:
 * on this database, 397 uploads carry 1,306 slide entries, so the per-page images outnumbered
 * everything the old list collected by roughly two to one. They were never deleted, and the
 * Upload row naming them was — leaving every page of every document of a deleted account public
 * at an unguessable but permanent URL, unreachable by any query that could find them again.
 *
 * `previewImageUrl` and `firstPagePngUrl` are not in the schema and are kept deliberately: the
 * processor writes them anyway and 333 rows here have them. A field being undeclared does not make
 * the file it points at imaginary.
 */
const UPLOAD_BLOB_KEYS = ["blobUrl", "previewImageUrl", "firstPagePngUrl", "extractedTextBlobUrl"] as const;

/**
 * How many uploads one purge run will look at.
 *
 * A bound is right — this runs in a 300s function — but a *silent* bound is not: an account over
 * the limit had the excess skipped by the blob pass and then deleted by the row pass, which is the
 * same orphaning the slide images suffered. `purgeAccount` now refuses to delete anything when the
 * scan hits this ceiling, and says so, so the account is left whole for a human rather than half
 * destroyed by a job.
 */
const UPLOAD_SCAN_LIMIT = 5000;

/** The projection any query feeding `blobUrlsOf` must use, so the two cannot drift apart. */
export const UPLOAD_BLOB_SELECT = {
  blobUrl: 1,
  previewImageUrl: 1,
  firstPagePngUrl: 1,
  extractedTextBlobUrl: 1,
  slideNodes: 1,
} as const;

export function blobUrlsOf(upload: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of UPLOAD_BLOB_KEYS) {
    const v = upload[key];
    if (typeof v === "string" && v.startsWith("http")) out.push(v);
  }
  const slides = upload.slideNodes;
  if (Array.isArray(slides)) {
    for (const node of slides) {
      if (!node || typeof node !== "object") continue;
      for (const key of ["imageUrl", "thumbUrl"]) {
        const v = (node as Record<string, unknown>)[key];
        if (typeof v === "string" && v.startsWith("http")) out.push(v);
      }
    }
  }
  return out;
}

/** What the purge would do for one account, without doing any of it. */
export async function planPurge(userId: string): Promise<PurgePlan | null> {
  if (!Types.ObjectId.isValid(userId)) return null;
  await connectMongo();
  const id = new Types.ObjectId(userId);
  const user = (await UserModel.findOne({ _id: id })
    .select({ email: 1, deletionRequestedAt: 1, deletionPurgeAfter: 1 })
    .lean()) as { email?: string; deletionRequestedAt?: Date | null; deletionPurgeAfter?: Date | null } | null;
  if (!user) return null;

  const memberships = (await OrgMembershipModel.find({ userId: id, isDeleted: { $ne: true } })
    .select({ orgId: 1, role: 1 })
    .limit(500)
    .lean()) as Array<{ orgId: Types.ObjectId; role?: string }>;

  const soloOrgIds: Types.ObjectId[] = [];
  const sharedOrgIds: Types.ObjectId[] = [];
  for (const m of memberships) {
    const others = await OrgMembershipModel.countDocuments({ orgId: m.orgId, userId: { $ne: id }, isDeleted: { $ne: true } });
    (others === 0 ? soloOrgIds : sharedOrgIds).push(m.orgId);
  }

  const orgFilter = { orgId: { $in: soloOrgIds } };
  const [docs, uploads, shareLinks, shareViews, activity, apiKeys, creditRows] = soloOrgIds.length
    ? await Promise.all([
        DocModel.countDocuments(orgFilter),
        UploadModel.countDocuments(orgFilter),
        ShareLinkModel.countDocuments(orgFilter),
        ShareViewModel.countDocuments(orgFilter),
        ActivityEventModel.countDocuments(orgFilter),
        ApiKeyModel.countDocuments(orgFilter),
        CreditLedgerModel.countDocuments({ workspaceId: { $in: soloOrgIds } }),
      ])
    : [0, 0, 0, 0, 0, 0, 0];

  // Count files without loading them all: one pass over the uploads that have any URL.
  const blobRows = soloOrgIds.length
    ? ((await UploadModel.find(orgFilter).select(UPLOAD_BLOB_SELECT).limit(UPLOAD_SCAN_LIMIT).lean()) as Record<string, unknown>[])
    : [];
  const blobs = blobRows.reduce((n, u) => n + blobUrlsOf(u).length, 0);

  return {
    userId,
    email: user.email ?? null,
    requestedAt: user.deletionRequestedAt ? new Date(user.deletionRequestedAt).toISOString() : null,
    purgeAfter: user.deletionPurgeAfter ? new Date(user.deletionPurgeAfter).toISOString() : null,
    soloOrgIds: soloOrgIds.map(String),
    sharedOrgIds: sharedOrgIds.map(String),
    counts: { docs, uploads, blobs, shareLinks, shareViews, activity, apiKeys, creditRows },
  };
}

export type PurgeResult = PurgePlan & {
  dryRun: boolean;
  blobsDeleted: number;
  blobErrors: number;
  /** Subscriptions this run cancelled in Stripe before destroying the row that pointed at them. */
  subscriptionsCancelled: number;
  /** Stripe refused or could not be reached. Like `blobErrors`, this stops the deletion. */
  stripeErrors: number;
  /**
   * Why nothing was deleted, when nothing was. Null on a clean run.
   *
   * A purge that half-succeeds is the worst outcome available: the rows naming the files are the
   * only way to find the files again, so deleting them after a failed blob pass turns a retryable
   * problem into permanent orphaned data. Every abort here leaves the account exactly as it was,
   * which is what makes the next night's run a retry rather than a second helping of damage.
   */
  abortedReason: string | null;
  purgedAt: string | null;
};

/**
 * Execute a plan. `dryRun` reports what would happen and writes nothing — the same code path, so a
 * dry run cannot drift from the real one.
 */
export async function purgeAccount(userId: string, opts?: { dryRun?: boolean }): Promise<PurgeResult | null> {
  const dryRun = Boolean(opts?.dryRun);
  const plan = await planPurge(userId);
  if (!plan) return null;

  const id = new Types.ObjectId(userId);
  const soloOrgIds = plan.soloOrgIds.map((s) => new Types.ObjectId(s));
  let blobsDeleted = 0;
  let blobErrors = 0;
  let subscriptionsCancelled = 0;
  let stripeErrors = 0;
  let abortedReason: string | null = null;

  const stop = (reason: string): PurgeResult => ({
    ...plan,
    dryRun,
    blobsDeleted,
    blobErrors,
    subscriptionsCancelled,
    stripeErrors,
    abortedReason: reason,
    purgedAt: null,
  });

  if (soloOrgIds.length) {
    const uploads = (await UploadModel.find({ orgId: { $in: soloOrgIds } })
      .select(UPLOAD_BLOB_SELECT)
      .limit(UPLOAD_SCAN_LIMIT)
      .lean()) as Record<string, unknown>[];
    // At the ceiling there may be more; deleting rows now would orphan whatever was not looked at.
    if (uploads.length >= UPLOAD_SCAN_LIMIT) {
      return stop(`more than ${UPLOAD_SCAN_LIMIT} uploads; refusing to delete a subset by hand`);
    }
    const urls = uploads.flatMap(blobUrlsOf);
    if (!dryRun) {
      // In batches: one bad URL must not stop the rest, and the store takes a list.
      for (let i = 0; i < urls.length; i += 50) {
        const batch = urls.slice(i, i + 50);
        try {
          await blobDel(batch);
          blobsDeleted += batch.length;
        } catch {
          blobErrors += batch.length;
        }
      }
      // The rows are the only index of these URLs. Keep them, and retry tomorrow.
      if (blobErrors > 0) return stop(`${blobErrors} blob deletions failed; rows kept so the next run can retry`);
    }
  }

  /**
   * Cancel in Stripe *before* destroying the row that knows the subscription id.
   *
   * Deleting the row first left a Pro customer being charged every month with nothing in the
   * product that could find the subscription again: the only pointer to it had been the row. The
   * card kept working, the account was gone, and the first sign of a problem would have been a
   * chargeback. If Stripe cannot be reached, nothing is deleted and the next run tries again.
   */
  if (!dryRun && soloOrgIds.length) {
    const subs = (await SubscriptionModel.find({ orgId: { $in: soloOrgIds }, stripeSubscriptionId: { $ne: null } })
      .select({ stripeSubscriptionId: 1 })
      .lean()) as Array<{ stripeSubscriptionId?: string | null }>;
    const ids = subs.map((r) => (r.stripeSubscriptionId ?? "").trim()).filter(Boolean);
    if (ids.length) {
      const key = (process.env.STRIPE_SECRET_KEY ?? "").trim();
      if (!key) return stop(`${ids.length} live subscription(s) but STRIPE_SECRET_KEY is unset; refusing to orphan them`);
      for (const subId of ids) {
        try {
          const res = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subId)}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${key}` },
          });
          // Already gone is success: the goal is "not being charged", not "we cancelled it".
          if (res.ok || res.status === 404) subscriptionsCancelled += 1;
          else stripeErrors += 1;
        } catch {
          stripeErrors += 1;
        }
      }
      if (stripeErrors > 0) return stop(`${stripeErrors} subscription(s) could not be cancelled; rows kept so the next run can retry`);
    }
  }

  if (!dryRun) {
    if (soloOrgIds.length) {
      /**
       * Every collection keyed to a workspace, not the twelve somebody remembered.
       *
       * Fifteen were missing, and the list was not a rounding error: `ShareViewerEmail` holds the
       * addresses **other people** typed into a share link, `ProjectLinkView` their visits,
       * `NotificationQueue` mail still waiting to be sent for a workspace that no longer exists,
       * and `OrgInvite` live invitations into it. An account deletion answered from this function
       * was answered wrongly, which is the kind of wrong that shows up in a data-subject request
       * rather than in a bug report.
       *
       * Grouped by the key each model actually uses — `orgId` for most, `workspaceId` for the
       * billing and usage rows — because getting that wrong deletes nothing and looks like success.
       * `src/lib/models` is the list to diff against when a new collection is added.
       */
      const orgFilter = { orgId: { $in: soloOrgIds } };
      const workspaceFilter = { workspaceId: { $in: soloOrgIds } };
      await Promise.all([
        DocModel.deleteMany(orgFilter),
        UploadModel.deleteMany(orgFilter),
        ShareLinkModel.deleteMany(orgFilter),
        ShareViewModel.deleteMany(orgFilter),
        ShareVisitModel.deleteMany(orgFilter),
        ActivityEventModel.deleteMany(orgFilter),
        ApiKeyModel.deleteMany(orgFilter),
        CreditLedgerModel.deleteMany(workspaceFilter),
        WorkspaceCreditBalanceModel.deleteMany(workspaceFilter),
        SubscriptionModel.deleteMany(orgFilter),
        OrgMembershipModel.deleteMany(orgFilter),
        OrgModel.deleteMany({ _id: { $in: soloOrgIds } }),
        // The fifteen that used to survive.
        CreditPurchaseModel.deleteMany(orgFilter),
        DocChangeModel.deleteMany(orgFilter),
        DocPageTimingModel.deleteMany(orgFilter),
        ErrorEventModel.deleteMany(workspaceFilter),
        NotificationEmailCursorModel.deleteMany(orgFilter),
        NotificationQueueModel.deleteMany(orgFilter),
        OrgInviteModel.deleteMany(orgFilter),
        ProjectModel.deleteMany(orgFilter),
        ProjectLinkViewModel.deleteMany(orgFilter),
        ShareViewerEmailModel.deleteMany(orgFilter),
        StarredDocModel.deleteMany(orgFilter),
        TagModel.deleteMany(orgFilter),
        TagAssignmentModel.deleteMany(orgFilter),
        UsageAggCycleModel.deleteMany(workspaceFilter),
        UsageAggDailyModel.deleteMany(workspaceFilter),
      ]);
    }
    // Memberships in workspaces that survive: the team keeps its documents, the leaver goes.
    await OrgMembershipModel.deleteMany({ userId: id });
    // The row stays as an anonymised tombstone rather than being deleted: every signed-in request
    // checks this row to end the session, and a token whose user has vanished would otherwise be
    // treated as a stranger and mint a fresh workspace. Nothing identifying survives.
    await UserModel.updateOne(
      { _id: id },
      {
        $set: {
          isActive: false,
          deletionPurgedAt: new Date(),
          email: `deleted+${String(id)}@lnkdrp.invalid`,
          name: null,
          image: null,
          providerAccountId: null,
          deletionReasonText: null,
          metadata: {},
        },
      },
    );
  }

  return {
    ...plan,
    dryRun,
    blobsDeleted,
    blobErrors,
    subscriptionsCancelled,
    stripeErrors,
    abortedReason,
    purgedAt: dryRun ? null : new Date().toISOString(),
  };
}

/** Accounts whose grace period has run out. */
export async function findAccountsDueForPurge(now = new Date(), limit = 25): Promise<string[]> {
  await connectMongo();
  const rows = (await UserModel.find({
    deletionRequestedAt: { $ne: null },
    deletionPurgedAt: null,
    deletionPurgeAfter: { $lte: now },
  })
    .select({ _id: 1 })
    .limit(limit)
    .lean()) as Array<{ _id: Types.ObjectId }>;
  return rows.map((r) => String(r._id));
}
