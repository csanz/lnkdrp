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

/** Every stored file an upload points at. Duplicates are fine; deletion is idempotent. */
function blobUrlsOf(upload: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["blobUrl", "previewImageUrl", "firstPagePngUrl", "extractedTextBlobUrl"]) {
    const v = upload[key];
    if (typeof v === "string" && v.startsWith("http")) out.push(v);
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
    ? ((await UploadModel.find(orgFilter)
        .select({ blobUrl: 1, previewImageUrl: 1, firstPagePngUrl: 1, extractedTextBlobUrl: 1 })
        .limit(5000)
        .lean()) as Record<string, unknown>[])
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

  if (soloOrgIds.length) {
    const uploads = (await UploadModel.find({ orgId: { $in: soloOrgIds } })
      .select({ blobUrl: 1, previewImageUrl: 1, firstPagePngUrl: 1, extractedTextBlobUrl: 1 })
      .limit(5000)
      .lean()) as Record<string, unknown>[];
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
    }
  }

  if (!dryRun) {
    if (soloOrgIds.length) {
      const orgFilter = { orgId: { $in: soloOrgIds } };
      await Promise.all([
        DocModel.deleteMany(orgFilter),
        UploadModel.deleteMany(orgFilter),
        ShareLinkModel.deleteMany(orgFilter),
        ShareViewModel.deleteMany(orgFilter),
        ShareVisitModel.deleteMany(orgFilter),
        ActivityEventModel.deleteMany(orgFilter),
        ApiKeyModel.deleteMany(orgFilter),
        CreditLedgerModel.deleteMany({ workspaceId: { $in: soloOrgIds } }),
        WorkspaceCreditBalanceModel.deleteMany({ workspaceId: { $in: soloOrgIds } }),
        SubscriptionModel.deleteMany({ orgId: { $in: soloOrgIds } }),
        OrgMembershipModel.deleteMany({ orgId: { $in: soloOrgIds } }),
        OrgModel.deleteMany({ _id: { $in: soloOrgIds } }),
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
