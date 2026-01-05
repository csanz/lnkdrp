/**
 * Orphan data report (read-only).
 *
 * Reports how many records reference missing parent records (e.g. Upload.docId → missing Doc).
 *
 * Usage:
 *   tsx scripts/orphan-data-report.ts
 *   tsx scripts/orphan-data-report.ts --sample 10
 */
import fs from "node:fs";
import path from "node:path";
import mongoose, { type Model } from "mongoose";
import dotenv from "dotenv";
import { connectMongo } from "@/lib/mongodb";
import { AiRunModel } from "@/lib/models/AiRun";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { DocChangeModel } from "@/lib/models/DocChange";
import { DocModel } from "@/lib/models/Doc";
import { DocPageTimingModel } from "@/lib/models/DocPageTiming";
import { DocReportModel } from "@/lib/models/DocReport";
import { ErrorEventModel } from "@/lib/models/ErrorEvent";
import { InviteModel } from "@/lib/models/Invite";
import { OrgInviteModel } from "@/lib/models/OrgInvite";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { OrgModel } from "@/lib/models/Org";
import { PageTimingModel } from "@/lib/models/PageTiming";
import { ProjectClickModel } from "@/lib/models/ProjectClick";
import { ProjectModel } from "@/lib/models/Project";
import { ProjectViewModel } from "@/lib/models/ProjectView";
import { ReviewModel } from "@/lib/models/Review";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { UploadModel } from "@/lib/models/Upload";
import { UsageAggCycleModel } from "@/lib/models/UsageAggCycle";
import { UsageAggDailyModel } from "@/lib/models/UsageAggDaily";
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

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  if (i < 0) return null;
  return process.argv[i + 1] ?? null;
}

function intArg(name: string, fallback: number): number {
  const raw = arg(name);
  if (!raw) return fallback;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(50, n));
}

type OrphanReport = {
  label: string;
  count: number;
  samples: Array<Record<string, unknown>>;
};

async function countMissingParent(opts: {
  label: string;
  // Mongoose's `Model<T>` typing is not structurally assignable across `T`,
  // so this helper intentionally accepts `Model<any>` (read-only aggregation usage).
  child: Model<any>;
  parent: Model<any>;
  localField: string;
  sampleSize: number;
  /**
   * Optional additional match to scope the child set.
   * (Example: only check when localField is non-null)
   */
  childMatch?: Record<string, unknown>;
}): Promise<OrphanReport> {
  const { label, child, parent, localField, childMatch, sampleSize } = opts;

  const match = {
    ...(childMatch ?? {}),
    [localField]: { $type: "objectId" },
  };

  const from = parent.collection.name;

  const rows = await child.aggregate([
    { $match: match },
    { $lookup: { from, localField, foreignField: "_id", as: "__parent" } },
    { $match: { "__parent.0": { $exists: false } } },
    {
      $facet: {
        meta: [{ $count: "n" }],
        sample: [
          {
            $project: {
              _id: 1,
              [localField]: 1,
            },
          },
          { $limit: sampleSize },
        ],
      },
    },
  ]);

  const meta = (rows?.[0] as { meta?: Array<{ n?: number }>; sample?: Array<Record<string, unknown>> }) ?? {};
  const count = meta.meta?.[0]?.n ?? 0;
  const samples = meta.sample ?? [];
  return { label, count, samples };
}

async function countMissingParentForArrayField(opts: {
  label: string;
  child: Model<any>;
  parent: Model<any>;
  arrayField: string;
  sampleSize: number;
  childMatch?: Record<string, unknown>;
}): Promise<OrphanReport> {
  const { label, child, parent, arrayField, childMatch, sampleSize } = opts;
  const from = parent.collection.name;

  const rows = await child.aggregate([
    { $match: { ...(childMatch ?? {}), [arrayField]: { $type: "array" } } },
    { $unwind: `$${arrayField}` },
    { $match: { [arrayField]: { $type: "objectId" } } },
    { $lookup: { from, localField: arrayField, foreignField: "_id", as: "__parent" } },
    { $match: { "__parent.0": { $exists: false } } },
    {
      $facet: {
        meta: [{ $count: "n" }],
        sample: [
          {
            $project: {
              _id: 1,
              [arrayField]: 1,
            },
          },
          { $limit: sampleSize },
        ],
      },
    },
  ]);

  const meta = (rows?.[0] as { meta?: Array<{ n?: number }>; sample?: Array<Record<string, unknown>> }) ?? {};
  const count = meta.meta?.[0]?.n ?? 0;
  const samples = meta.sample ?? [];
  return { label, count, samples };
}

function printReport(r: OrphanReport) {
  if (r.count === 0) {
    console.log(`- ${r.label}: 0`);
    return;
  }
  console.log(`- ${r.label}: ${r.count}`);
  if (r.samples.length) {
    console.log(`  sample:`);
    for (const s of r.samples) console.log(`  - ${JSON.stringify(s)}`);
  }
}

async function main() {
  const sampleSize = intArg("--sample", 5);

  loadEnvFiles();
  await connectMongo();

  const reports: OrphanReport[] = [];

  // --- Core entities ---------------------------------------------------------
  reports.push(
    await countMissingParent({
      label: "Doc.userId -> missing User",
      child: DocModel,
      parent: UserModel,
      localField: "userId",
      sampleSize,
    }),
  );
  reports.push(
    await countMissingParent({
      label: "Doc.orgId -> missing Org",
      child: DocModel,
      parent: OrgModel,
      localField: "orgId",
      sampleSize,
      childMatch: { orgId: { $ne: null } },
    }),
  );
  reports.push(
    await countMissingParent({
      label: "Doc.projectId -> missing Project",
      child: DocModel,
      parent: ProjectModel,
      localField: "projectId",
      sampleSize,
      childMatch: { projectId: { $ne: null } },
    }),
  );
  reports.push(
    await countMissingParentForArrayField({
      label: "Doc.projectIds[*] -> missing Project",
      child: DocModel,
      parent: ProjectModel,
      arrayField: "projectIds",
      sampleSize,
    }),
  );
  reports.push(
    await countMissingParent({
      label: "Doc.currentUploadId -> missing Upload",
      child: DocModel,
      parent: UploadModel,
      localField: "currentUploadId",
      sampleSize,
      childMatch: { currentUploadId: { $ne: null } },
    }),
  );
  reports.push(
    await countMissingParent({
      label: "Doc.uploadId -> missing Upload",
      child: DocModel,
      parent: UploadModel,
      localField: "uploadId",
      sampleSize,
      childMatch: { uploadId: { $ne: null } },
    }),
  );

  reports.push(
    await countMissingParent({
      label: "Project.userId -> missing User",
      child: ProjectModel,
      parent: UserModel,
      localField: "userId",
      sampleSize,
    }),
  );
  reports.push(
    await countMissingParent({
      label: "Project.orgId -> missing Org",
      child: ProjectModel,
      parent: OrgModel,
      localField: "orgId",
      sampleSize,
      childMatch: { orgId: { $ne: null } },
    }),
  );
  reports.push(
    await countMissingParent({
      label: "Project.requestReviewGuideDocId -> missing Doc",
      child: ProjectModel,
      parent: DocModel,
      localField: "requestReviewGuideDocId",
      sampleSize,
      childMatch: { requestReviewGuideDocId: { $ne: null } },
    }),
  );

  reports.push(
    await countMissingParent({
      label: "Upload.docId -> missing Doc",
      child: UploadModel,
      parent: DocModel,
      localField: "docId",
      sampleSize,
    }),
  );
  reports.push(
    await countMissingParent({
      label: "Upload.userId -> missing User",
      child: UploadModel,
      parent: UserModel,
      localField: "userId",
      sampleSize,
    }),
  );
  reports.push(
    await countMissingParent({
      label: "Upload.orgId -> missing Org",
      child: UploadModel,
      parent: OrgModel,
      localField: "orgId",
      sampleSize,
      childMatch: { orgId: { $ne: null } },
    }),
  );

  // --- Sharing + metrics -----------------------------------------------------
  reports.push(
    await countMissingParent({
      label: "ShareView.docId -> missing Doc",
      child: (await import("@/lib/models/ShareView")).ShareViewModel,
      parent: DocModel,
      localField: "docId",
      sampleSize,
    }),
  );
  reports.push(
    await countMissingParent({
      label: "ShareView.viewerUserId -> missing User",
      child: (await import("@/lib/models/ShareView")).ShareViewModel,
      parent: UserModel,
      localField: "viewerUserId",
      sampleSize,
      childMatch: { viewerUserId: { $ne: null } },
    }),
  );

  reports.push(
    await countMissingParent({
      label: "ProjectView.projectId -> missing Project",
      child: ProjectViewModel,
      parent: ProjectModel,
      localField: "projectId",
      sampleSize,
    }),
  );
  reports.push(
    await countMissingParent({
      label: "ProjectView.viewerUserId -> missing User",
      child: ProjectViewModel,
      parent: UserModel,
      localField: "viewerUserId",
      sampleSize,
    }),
  );

  reports.push(
    await countMissingParent({
      label: "ProjectClick.projectId -> missing Project",
      child: ProjectClickModel,
      parent: ProjectModel,
      localField: "projectId",
      sampleSize,
    }),
  );
  reports.push(
    await countMissingParent({
      label: "ProjectClick.viewerUserId -> missing User",
      child: ProjectClickModel,
      parent: UserModel,
      localField: "viewerUserId",
      sampleSize,
    }),
  );
  reports.push(
    await countMissingParent({
      label: "ProjectClick.toDocId -> missing Doc",
      child: ProjectClickModel,
      parent: DocModel,
      localField: "toDocId",
      sampleSize,
      childMatch: { toDocId: { $ne: null } },
    }),
  );

  reports.push(
    await countMissingParent({
      label: "PageTiming.viewerUserId -> missing User",
      child: PageTimingModel,
      parent: UserModel,
      localField: "viewerUserId",
      sampleSize,
    }),
  );
  reports.push(
    await countMissingParent({
      label: "DocPageTiming.orgId -> missing Org",
      child: DocPageTimingModel,
      parent: OrgModel,
      localField: "orgId",
      sampleSize,
    }),
  );
  reports.push(
    await countMissingParent({
      label: "DocPageTiming.docId -> missing Doc",
      child: DocPageTimingModel,
      parent: DocModel,
      localField: "docId",
      sampleSize,
    }),
  );
  reports.push(
    await countMissingParent({
      label: "DocPageTiming.viewerUserId -> missing User",
      child: DocPageTimingModel,
      parent: UserModel,
      localField: "viewerUserId",
      sampleSize,
    }),
  );

  // --- Reviews + history -----------------------------------------------------
  reports.push(
    await countMissingParent({
      label: "Review.docId -> missing Doc",
      child: ReviewModel,
      parent: DocModel,
      localField: "docId",
      sampleSize,
    }),
  );
  reports.push(
    await countMissingParent({
      label: "Review.uploadId -> missing Upload",
      child: ReviewModel,
      parent: UploadModel,
      localField: "uploadId",
      sampleSize,
    }),
  );
  reports.push(
    await countMissingParent({
      label: "Review.priorReviewId -> missing Review",
      child: ReviewModel,
      parent: ReviewModel,
      localField: "priorReviewId",
      sampleSize,
      childMatch: { priorReviewId: { $ne: null } },
    }),
  );

  reports.push(
    await countMissingParent({
      label: "DocChange.orgId -> missing Org",
      child: DocChangeModel,
      parent: OrgModel,
      localField: "orgId",
      sampleSize,
      childMatch: { orgId: { $ne: null } },
    }),
  );
  reports.push(
    await countMissingParent({
      label: "DocChange.docId -> missing Doc",
      child: DocChangeModel,
      parent: DocModel,
      localField: "docId",
      sampleSize,
    }),
  );
  reports.push(
    await countMissingParent({
      label: "DocChange.createdByUserId -> missing User",
      child: DocChangeModel,
      parent: UserModel,
      localField: "createdByUserId",
      sampleSize,
      childMatch: { createdByUserId: { $ne: null } },
    }),
  );
  reports.push(
    await countMissingParent({
      label: "DocChange.fromUploadId -> missing Upload",
      child: DocChangeModel,
      parent: UploadModel,
      localField: "fromUploadId",
      sampleSize,
      childMatch: { fromUploadId: { $ne: null } },
    }),
  );
  reports.push(
    await countMissingParent({
      label: "DocChange.toUploadId -> missing Upload",
      child: DocChangeModel,
      parent: UploadModel,
      localField: "toUploadId",
      sampleSize,
    }),
  );

  reports.push(
    await countMissingParent({
      label: "DocReport.userId -> missing User",
      child: DocReportModel,
      parent: UserModel,
      localField: "userId",
      sampleSize,
    }),
  );
  reports.push(
    await countMissingParent({
      label: "DocReport.docId -> missing Doc",
      child: DocReportModel,
      parent: DocModel,
      localField: "docId",
      sampleSize,
    }),
  );

  // --- Orgs + membership/invites --------------------------------------------
  reports.push(
    await countMissingParent({
      label: "Org.createdByUserId -> missing User",
      child: OrgModel,
      parent: UserModel,
      localField: "createdByUserId",
      sampleSize,
    }),
  );
  reports.push(
    await countMissingParent({
      label: "Org.personalForUserId -> missing User",
      child: OrgModel,
      parent: UserModel,
      localField: "personalForUserId",
      sampleSize,
      childMatch: { personalForUserId: { $ne: null } },
    }),
  );

  reports.push(
    await countMissingParent({
      label: "OrgMembership.orgId -> missing Org",
      child: OrgMembershipModel,
      parent: OrgModel,
      localField: "orgId",
      sampleSize,
    }),
  );
  reports.push(
    await countMissingParent({
      label: "OrgMembership.userId -> missing User",
      child: OrgMembershipModel,
      parent: UserModel,
      localField: "userId",
      sampleSize,
    }),
  );

  reports.push(
    await countMissingParent({
      label: "OrgInvite.orgId -> missing Org",
      child: OrgInviteModel,
      parent: OrgModel,
      localField: "orgId",
      sampleSize,
    }),
  );
  reports.push(
    await countMissingParent({
      label: "OrgInvite.createdByUserId -> missing User",
      child: OrgInviteModel,
      parent: UserModel,
      localField: "createdByUserId",
      sampleSize,
    }),
  );
  reports.push(
    await countMissingParent({
      label: "OrgInvite.redeemedByUserId -> missing User",
      child: OrgInviteModel,
      parent: UserModel,
      localField: "redeemedByUserId",
      sampleSize,
      childMatch: { redeemedByUserId: { $ne: null } },
    }),
  );

  reports.push(
    await countMissingParent({
      label: "Invite.approvedByUserId -> missing User",
      child: InviteModel,
      parent: UserModel,
      localField: "approvedByUserId",
      sampleSize,
      childMatch: { approvedByUserId: { $ne: null } },
    }),
  );
  reports.push(
    await countMissingParent({
      label: "Invite.approvedInviteId -> missing Invite",
      child: InviteModel,
      parent: InviteModel,
      localField: "approvedInviteId",
      sampleSize,
      childMatch: { approvedInviteId: { $ne: null } },
    }),
  );

  // --- Billing/usage ---------------------------------------------------------
  reports.push(
    await countMissingParent({
      label: "Subscription.orgId -> missing Org",
      child: SubscriptionModel,
      parent: OrgModel,
      localField: "orgId",
      sampleSize,
    }),
  );
  reports.push(
    await countMissingParent({
      label: "WorkspaceCreditBalance.workspaceId -> missing Org",
      child: WorkspaceCreditBalanceModel,
      parent: OrgModel,
      localField: "workspaceId",
      sampleSize,
    }),
  );
  reports.push(
    await countMissingParent({
      label: "CreditLedger.workspaceId -> missing Org",
      child: CreditLedgerModel,
      parent: OrgModel,
      localField: "workspaceId",
      sampleSize,
    }),
  );
  reports.push(
    await countMissingParent({
      label: "CreditLedger.userId -> missing User",
      child: CreditLedgerModel,
      parent: UserModel,
      localField: "userId",
      sampleSize,
      childMatch: { userId: { $ne: null } },
    }),
  );
  reports.push(
    await countMissingParent({
      label: "CreditLedger.docId -> missing Doc",
      child: CreditLedgerModel,
      parent: DocModel,
      localField: "docId",
      sampleSize,
      childMatch: { docId: { $ne: null } },
    }),
  );
  reports.push(
    await countMissingParent({
      label: "UsageAggDaily.workspaceId -> missing Org",
      child: UsageAggDailyModel,
      parent: OrgModel,
      localField: "workspaceId",
      sampleSize,
    }),
  );
  reports.push(
    await countMissingParent({
      label: "UsageAggCycle.workspaceId -> missing Org",
      child: UsageAggCycleModel,
      parent: OrgModel,
      localField: "workspaceId",
      sampleSize,
    }),
  );

  // --- Debug logs ------------------------------------------------------------
  reports.push(
    await countMissingParent({
      label: "AiRun.userId -> missing User",
      child: AiRunModel,
      parent: UserModel,
      localField: "userId",
      sampleSize,
      childMatch: { userId: { $ne: null } },
    }),
  );
  reports.push(
    await countMissingParent({
      label: "AiRun.projectId -> missing Project",
      child: AiRunModel,
      parent: ProjectModel,
      localField: "projectId",
      sampleSize,
      childMatch: { projectId: { $ne: null } },
    }),
  );
  reports.push(
    await countMissingParentForArrayField({
      label: "AiRun.projectIds[*] -> missing Project",
      child: AiRunModel,
      parent: ProjectModel,
      arrayField: "projectIds",
      sampleSize,
    }),
  );
  reports.push(
    await countMissingParent({
      label: "AiRun.docId -> missing Doc",
      child: AiRunModel,
      parent: DocModel,
      localField: "docId",
      sampleSize,
      childMatch: { docId: { $ne: null } },
    }),
  );
  reports.push(
    await countMissingParent({
      label: "AiRun.uploadId -> missing Upload",
      child: AiRunModel,
      parent: UploadModel,
      localField: "uploadId",
      sampleSize,
      childMatch: { uploadId: { $ne: null } },
    }),
  );
  reports.push(
    await countMissingParent({
      label: "AiRun.reviewId -> missing Review",
      child: AiRunModel,
      parent: ReviewModel,
      localField: "reviewId",
      sampleSize,
      childMatch: { reviewId: { $ne: null } },
    }),
  );

  reports.push(
    await countMissingParent({
      label: "ErrorEvent.workspaceId -> missing Org",
      child: ErrorEventModel,
      parent: OrgModel,
      localField: "workspaceId",
      sampleSize,
      childMatch: { workspaceId: { $ne: null } },
    }),
  );
  reports.push(
    await countMissingParent({
      label: "ErrorEvent.userId -> missing User",
      child: ErrorEventModel,
      parent: UserModel,
      localField: "userId",
      sampleSize,
      childMatch: { userId: { $ne: null } },
    }),
  );
  reports.push(
    await countMissingParent({
      label: "ErrorEvent.docId -> missing Doc",
      child: ErrorEventModel,
      parent: DocModel,
      localField: "docId",
      sampleSize,
      childMatch: { docId: { $ne: null } },
    }),
  );
  reports.push(
    await countMissingParent({
      label: "ErrorEvent.uploadId -> missing Upload",
      child: ErrorEventModel,
      parent: UploadModel,
      localField: "uploadId",
      sampleSize,
      childMatch: { uploadId: { $ne: null } },
    }),
  );
  reports.push(
    await countMissingParent({
      label: "ErrorEvent.runId -> missing AiRun",
      child: ErrorEventModel,
      parent: AiRunModel,
      localField: "runId",
      sampleSize,
      childMatch: { runId: { $ne: null } },
    }),
  );

  console.log("[orphan-data-report] sampleSize=%d", sampleSize);
  let total = 0;
  for (const r of reports) {
    total += r.count;
    printReport(r);
  }
  console.log(`[orphan-data-report] total orphan references: ${total}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});


