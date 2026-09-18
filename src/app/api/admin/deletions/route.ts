/**
 * `GET /api/admin/deletions` — who asked to delete their account, when, and why.
 *
 * Read-only. The list is small by nature (one row per departing account), so it is a plain find
 * with a cap rather than a paged endpoint. `state=pending|purged|all` filters by whether the purge
 * job has run for that account yet.
 */
import { NextResponse } from "next/server";

import { connectMongo } from "@/lib/mongodb";
import { requireAdmin } from "@/lib/gating/requireAdmin";
import { UserModel } from "@/lib/models/User";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { CronHealthModel } from "@/lib/models/CronHealth";
import { DELETION_GRACE_DAYS, reasonLabel } from "@/lib/accounts/deletion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const state = (new URL(request.url).searchParams.get("state") ?? "all").trim();
  if (!["pending", "purged", "all"].includes(state)) {
    return NextResponse.json({ error: "state must be one of: pending | purged | all" }, { status: 400 });
  }

  await connectMongo();
  const filter: Record<string, unknown> = { deletionRequestedAt: { $ne: null } };
  if (state === "pending") filter.deletionPurgedAt = null;
  if (state === "purged") filter.deletionPurgedAt = { $ne: null };

  const rows = (await UserModel.find(filter)
    .select({
      email: 1,
      name: 1,
      deletionRequestedAt: 1,
      deletionReasonCode: 1,
      deletionReasonText: 1,
      deletionPurgeAfter: 1,
      deletionPurgedAt: 1,
    })
    .sort({ deletionRequestedAt: -1 })
    .limit(200)
    .lean()) as Array<Record<string, unknown>>;

  // How much is still standing for each account, so the purge is not a surprise.
  const counts = await Promise.all(
    rows.map((r) =>
      OrgMembershipModel.countDocuments({ userId: r._id, isDeleted: { $ne: true } }).catch(() => 0),
    ),
  );

  const job = (await CronHealthModel.findOne({ jobKey: "account-purge" })
    .select({ status: 1, lastRunAt: 1, lastResult: 1, lastError: 1 })
    .lean()) as Record<string, unknown> | null;

  return NextResponse.json({
    ok: true,
    graceDays: DELETION_GRACE_DAYS,
    job: job
      ? {
          status: typeof job.status === "string" ? job.status : null,
          lastRunAt: job.lastRunAt ? new Date(String(job.lastRunAt)).toISOString() : null,
          lastResult: job.lastResult ?? null,
          lastError: typeof job.lastError === "string" ? job.lastError : null,
        }
      : null,
    deletions: rows.map((r, i) => ({
      userId: String(r._id),
      email: typeof r.email === "string" ? r.email : null,
      name: typeof r.name === "string" ? r.name : null,
      requestedAt: r.deletionRequestedAt ? new Date(String(r.deletionRequestedAt)).toISOString() : null,
      reasonCode: typeof r.deletionReasonCode === "string" ? r.deletionReasonCode : null,
      reasonLabel: reasonLabel(typeof r.deletionReasonCode === "string" ? r.deletionReasonCode : null),
      reasonText: typeof r.deletionReasonText === "string" ? r.deletionReasonText : null,
      purgeAfter: r.deletionPurgeAfter ? new Date(String(r.deletionPurgeAfter)).toISOString() : null,
      purgedAt: r.deletionPurgedAt ? new Date(String(r.deletionPurgedAt)).toISOString() : null,
      workspaces: counts[i] ?? 0,
    })),
  });
}
