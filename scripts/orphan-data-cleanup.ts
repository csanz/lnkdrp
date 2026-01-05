/**
 * Orphan data cleanup (safe-by-default).
 *
 * Fixes / removes records that reference missing parent records.
 *
 * Defaults to dry-run. Use `--apply` to actually mutate data.
 *
 * Usage:
 *   tsx scripts/orphan-data-cleanup.ts
 *   tsx scripts/orphan-data-cleanup.ts --apply
 *   tsx scripts/orphan-data-cleanup.ts --apply --limit 1000
 */
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import mongoose, { type Model, type Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { OrgModel } from "@/lib/models/Org";
import { PageTimingModel } from "@/lib/models/PageTiming";
import { ProjectModel } from "@/lib/models/Project";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { UploadModel } from "@/lib/models/Upload";
import { UserModel } from "@/lib/models/User";
import { WorkspaceCreditBalanceModel } from "@/lib/models/WorkspaceCreditBalance";

function loadEnvFiles() {
  // Next.js loads `.env.local` automatically, but plain Node scripts do not.
  // Load `.env.local` then `.env` (without overriding already-set env vars).
  const root = process.cwd();
  const files = [".env.local", ".env"];
  for (const f of files) {
    const p = path.join(root, f);
    try {
      if (fs.existsSync(p)) dotenv.config({ path: p, override: false });
    } catch {
      // ignore
    }
  }
}

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  if (i < 0) return null;
  return process.argv[i + 1] ?? null;
}

function intArg(name: string, fallback: number, opts?: { min?: number; max?: number }): number {
  const raw = arg(name);
  if (!raw) return fallback;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  const min = opts?.min ?? 0;
  const max = opts?.max ?? 1_000_000_000;
  return Math.max(min, Math.min(max, n));
}

async function orphanIdsByLookup(opts: {
  child: Model<any>;
  parent: Model<any>;
  localField: string;
  childMatch?: Record<string, unknown>;
  limit: number | null;
}): Promise<Types.ObjectId[]> {
  const { child, parent, localField, childMatch, limit } = opts;
  const from = parent.collection.name;
  const pipeline: Record<string, any>[] = [
    { $match: { ...(childMatch ?? {}), [localField]: { $type: "objectId" } } },
    { $lookup: { from, localField, foreignField: "_id", as: "__parent" } },
    { $match: { "__parent.0": { $exists: false } } },
    { $project: { _id: 1 } },
  ];
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) pipeline.push({ $limit: limit });
  const rows = await child.aggregate(pipeline).allowDiskUse(true);
  return rows.map((r: any) => r._id).filter(Boolean);
}

function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function deleteManyByIds(opts: {
  label: string;
  model: Model<any>;
  ids: Types.ObjectId[];
  apply: boolean;
}): Promise<number> {
  const { label, model, ids, apply } = opts;
  if (!ids.length) {
    console.log(`- ${label}: 0`);
    return 0;
  }
  console.log(`- ${label}: ${ids.length}${apply ? " (deleting)" : " (dry-run)"}`);
  if (!apply) return ids.length;

  let deleted = 0;
  for (const group of chunk(ids, 1000)) {
    const res = await model.deleteMany({ _id: { $in: group } });
    deleted += res.deletedCount ?? 0;
  }
  return deleted;
}

async function updateManyNullFieldByIds(opts: {
  label: string;
  model: Model<any>;
  ids: Types.ObjectId[];
  field: string;
  apply: boolean;
}): Promise<number> {
  const { label, model, ids, field, apply } = opts;
  if (!ids.length) {
    console.log(`- ${label}: 0`);
    return 0;
  }
  console.log(`- ${label}: ${ids.length}${apply ? ` (setting ${field}=null)` : " (dry-run)"}`);
  if (!apply) return ids.length;

  let updated = 0;
  for (const group of chunk(ids, 1000)) {
    const res = await model.updateMany({ _id: { $in: group } }, { $set: { [field]: null } });
    updated += res.modifiedCount ?? 0;
  }
  return updated;
}

async function main() {
  const apply = hasArg("--apply");
  const limit = (() => {
    const raw = arg("--limit");
    if (!raw) return null;
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  })();

  loadEnvFiles();
  await connectMongo();

  console.log("[orphan-data-cleanup] apply=%s limit=%s", String(apply), limit === null ? "none" : String(limit));

  // 1) ShareView.viewerUserId -> missing User: preserve the ShareView row, just null out the optional field.
  const { ShareViewModel } = await import("@/lib/models/ShareView");
  const shareViewOrphanViewerIds = await orphanIdsByLookup({
    child: ShareViewModel,
    parent: UserModel,
    localField: "viewerUserId",
    childMatch: { viewerUserId: { $ne: null } },
    limit,
  });
  await updateManyNullFieldByIds({
    label: "ShareView.viewerUserId -> missing User",
    model: ShareViewModel,
    ids: shareViewOrphanViewerIds,
    field: "viewerUserId",
    apply,
  });

  // 2) PageTiming.viewerUserId -> missing User: these are pure metrics rows; safe to delete.
  const pageTimingOrphanViewerIds = await orphanIdsByLookup({
    child: PageTimingModel,
    parent: UserModel,
    localField: "viewerUserId",
    limit,
  });
  await deleteManyByIds({
    label: "PageTiming.viewerUserId -> missing User",
    model: PageTimingModel,
    ids: pageTimingOrphanViewerIds,
    apply,
  });

  // 3) OrgMembership.userId -> missing User: membership can never be valid; delete.
  const membershipOrphanUserIds = await orphanIdsByLookup({
    child: OrgMembershipModel,
    parent: UserModel,
    localField: "userId",
    limit,
  });
  await deleteManyByIds({
    label: "OrgMembership.userId -> missing User",
    model: OrgMembershipModel,
    ids: membershipOrphanUserIds,
    apply,
  });

  // 4) Personal orgs with missing personalForUserId: delete only when there is no dependent data.
  // (We avoid touching team orgs; those could still have real members.)
  const personalOrgsWithMissingUser = await OrgModel.aggregate([
    { $match: { type: "personal", personalForUserId: { $type: "objectId" } } },
    { $lookup: { from: UserModel.collection.name, localField: "personalForUserId", foreignField: "_id", as: "__u" } },
    { $match: { "__u.0": { $exists: false } } },
    { $project: { _id: 1 } },
    ...(limit ? [{ $limit: limit }] : []),
  ]).allowDiskUse(true);
  const personalOrgIds: Types.ObjectId[] = personalOrgsWithMissingUser.map((r: any) => r._id).filter(Boolean);

  if (!personalOrgIds.length) {
    console.log("- Personal Org.personalForUserId -> missing User: 0");
  } else {
    console.log(`- Personal Org.personalForUserId -> missing User: ${personalOrgIds.length}${apply ? " (evaluating)" : " (dry-run)"} `);
  }

  let deletedOrgs = 0;
  for (const orgId of personalOrgIds) {
    // Dependent collections that should be empty for a truly-dead personal org.
    const [docs, projects, uploads, subs, creditBalances, memberships] = await Promise.all([
      DocModel.countDocuments({ orgId }),
      ProjectModel.countDocuments({ orgId }),
      UploadModel.countDocuments({ orgId }),
      SubscriptionModel.countDocuments({ orgId }),
      WorkspaceCreditBalanceModel.countDocuments({ workspaceId: orgId }),
      OrgMembershipModel.countDocuments({ orgId }),
    ]);

    const okToDelete = docs === 0 && projects === 0 && uploads === 0 && subs === 0 && creditBalances === 0;

    if (!okToDelete) {
      console.log(
        `  - skip orgId=${String(orgId)} (has deps: docs=${docs} projects=${projects} uploads=${uploads} subs=${subs} creditBalances=${creditBalances} memberships=${memberships})`,
      );
      continue;
    }

    console.log(`  - delete orgId=${String(orgId)} (memberships=${memberships})${apply ? "" : " (dry-run)"}`);
    if (!apply) continue;

    // Best-effort cascade of org-scoped rows that should be empty, plus memberships.
    await Promise.all([
      OrgMembershipModel.deleteMany({ orgId }),
      SubscriptionModel.deleteMany({ orgId }),
      WorkspaceCreditBalanceModel.deleteMany({ workspaceId: orgId }),
    ]);
    const res = await OrgModel.deleteOne({ _id: orgId });
    deletedOrgs += res.deletedCount ?? 0;
  }

  if (personalOrgIds.length) {
    console.log(`[orphan-data-cleanup] personal orgs deleted: ${apply ? deletedOrgs : 0}`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});


