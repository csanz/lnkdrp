/**
 * `GET /api/admin/overview?days=30` — the state of the deployment, for the admin home.
 *
 * One request, because the home page is a dashboard and four spinners is not a dashboard. Series
 * are by UTC day over the window, filled so a quiet day reads as zero rather than as a gap.
 *
 * Every count is deployment-wide: this page answers "how is the product doing", not "how is one
 * workspace doing" (that is the workspace hub).
 */
import { NextResponse } from "next/server";

import { connectMongo } from "@/lib/mongodb";
import { requireAdmin } from "@/lib/gating/requireAdmin";
import { UserModel } from "@/lib/models/User";
import { OrgModel } from "@/lib/models/Org";
import { DocModel } from "@/lib/models/Doc";
import { ShareViewModel } from "@/lib/models/ShareView";
import { ShareLinkModel } from "@/lib/models/ShareLink";
import { AiRunModel } from "@/lib/models/AiRun";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { CronHealthModel } from "@/lib/models/CronHealth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_DAYS = [7, 30, 90] as const;

type DayRow = { _id: string; n: number };

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Every day in the window, zero-filled, in order. */
function fill(days: DayRow[], since: Date, until: Date, key: string): Array<Record<string, string | number>> {
  const by = new Map(days.map((d) => [String(d._id), Number(d.n) || 0]));
  const out: Array<Record<string, string | number>> = [];
  const cursor = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()));
  const end = Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), until.getUTCDate());
  while (cursor.getTime() <= end) {
    const k = dayKey(cursor);
    out.push({ day: k, [key]: by.get(k) ?? 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/** One `$group` by UTC day over a date field. */
function byDay(field: string) {
  return [{ $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: `$${field}` } }, n: { $sum: 1 } } }, { $sort: { _id: 1 } }] as const;
}

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const daysRaw = Number(new URL(request.url).searchParams.get("days") ?? 30);
  const days = (ALLOWED_DAYS as readonly number[]).includes(daysRaw) ? daysRaw : 30;
  const until = new Date();
  const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);
  const prevSince = new Date(since.getTime() - days * 24 * 60 * 60 * 1000);

  await connectMongo();

  const [
    users,
    newUsers,
    prevNewUsers,
    orgs,
    docs,
    newDocs,
    prevNewDocs,
    liveLinks,
    views,
    prevViews,
    aiRuns,
    creditsCharged,
    viewSeries,
    docSeries,
    userSeries,
    aiSeries,
    jobs,
    pendingDeletions,
  ] = await Promise.all([
    // A purged account leaves an anonymised tombstone row. It is not an account any more and it is
    // not a signup: counting it put five of my own test accounts in "signups" on this page.
    UserModel.countDocuments({ isActive: { $ne: false }, deletionPurgedAt: null }),
    UserModel.countDocuments({ createdAt: { $gte: since }, deletionPurgedAt: null }),
    UserModel.countDocuments({ createdAt: { $gte: prevSince, $lt: since }, deletionPurgedAt: null }),
    OrgModel.countDocuments({ isDeleted: { $ne: true } }),
    DocModel.countDocuments({ isDeleted: { $ne: true }, isArchived: { $ne: true } }),
    DocModel.countDocuments({ createdDate: { $gte: since } }),
    DocModel.countDocuments({ createdDate: { $gte: prevSince, $lt: since } }),
    ShareLinkModel.countDocuments({ enabled: { $ne: false }, archivedAt: null }),
    ShareViewModel.countDocuments({ createdDate: { $gte: since }, isOwnerPreview: { $ne: true } }),
    ShareViewModel.countDocuments({ createdDate: { $gte: prevSince, $lt: since }, isOwnerPreview: { $ne: true } }),
    AiRunModel.countDocuments({ createdDate: { $gte: since } }),
    CreditLedgerModel.aggregate<{ _id: null; n: number }>([
      { $match: { status: "charged", createdDate: { $gte: since } } },
      // The ledger stores the charged amount in `creditsCharged`; `credits` does not exist.
      { $group: { _id: null, n: { $sum: "$creditsCharged" } } },
    ]),
    ShareViewModel.aggregate<DayRow>([{ $match: { createdDate: { $gte: since }, isOwnerPreview: { $ne: true } } }, ...byDay("createdDate")]),
    DocModel.aggregate<DayRow>([{ $match: { createdDate: { $gte: since } } }, ...byDay("createdDate")]),
    UserModel.aggregate<DayRow>([{ $match: { createdAt: { $gte: since }, deletionPurgedAt: null } }, ...byDay("createdAt")]),
    AiRunModel.aggregate<DayRow>([{ $match: { createdDate: { $gte: since } } }, ...byDay("createdDate")]),
    CronHealthModel.find({}).select({ jobKey: 1, status: 1, lastRunAt: 1, lastError: 1 }).limit(50).lean(),
    UserModel.countDocuments({ deletionRequestedAt: { $ne: null }, deletionPurgedAt: null }),
  ]);

  // One series array the chart can switch metrics on, rather than four parallel arrays.
  const viewsFilled = fill(viewSeries, since, until, "views");
  const docsFilled = fill(docSeries, since, until, "docs");
  const usersFilled = fill(userSeries, since, until, "users");
  const aiFilled = fill(aiSeries, since, until, "aiRuns");
  const series = viewsFilled.map((row, i) => ({
    day: String(row.day),
    views: Number(viewsFilled[i]?.views ?? 0),
    docs: Number(docsFilled[i]?.docs ?? 0),
    users: Number(usersFilled[i]?.users ?? 0),
    aiRuns: Number(aiFilled[i]?.aiRuns ?? 0),
  }));

  const failing = (jobs as Array<{ jobKey?: string; status?: string }>).filter((j) => j.status === "error").map((j) => String(j.jobKey));

  return NextResponse.json({
    ok: true,
    days,
    totals: {
      users,
      orgs,
      docs,
      liveLinks,
      views,
      aiRuns,
      creditsCharged: Number(creditsCharged?.[0]?.n ?? 0),
      newUsers,
      newDocs,
    },
    trend: {
      users: { current: newUsers, previous: prevNewUsers },
      docs: { current: newDocs, previous: prevNewDocs },
      views: { current: views, previous: prevViews },
    },
    health: { jobs: (jobs as unknown[]).length, failing, pendingDeletions },
    series,
  });
}
