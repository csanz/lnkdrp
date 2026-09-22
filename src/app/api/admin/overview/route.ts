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
import { ActivityEventModel } from "@/lib/models/ActivityEvent";

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
    planLimitHits,
  ] = await Promise.all([
    // A purged account leaves an anonymised tombstone row. It is not an account any more and it is
    // not a signup: counting it put five of my own test accounts in "signups" on this page.
    //
    // `isTemp` is the same rule applied at the other end. `resolveActor` mints a temp user (and a
    // personal org, and a membership) for every anonymous visitor who touches an upload, so a row
    // with `isTemp: true` is a cookie, not a person: it was never an account and it never signed
    // up. Counting them made this page report 42 accounts and 45 workspaces for a deployment with
    // two accounts, and turned the Signups tile, its trend percentage and the signups series into a
    // count of anonymous traffic. Every other surface that answers "how many real people" already
    // filters them out (`/api/admin/waitlist`, the plan-limit cron); `/a/data/users` keeps them but
    // renders a "Temp" pill, which is a row browser being honest, not a headline metric.
    UserModel.countDocuments({ isTemp: { $ne: true }, isActive: { $ne: false }, deletionPurgedAt: null }),
    UserModel.countDocuments({ isTemp: { $ne: true }, createdAt: { $gte: since }, deletionPurgedAt: null }),
    UserModel.countDocuments({ isTemp: { $ne: true }, createdAt: { $gte: prevSince, $lt: since }, deletionPurgedAt: null }),
    // Workspaces, for the same reason, minus the personal org minted alongside each temp user. The
    // org row says nothing about temp, so the owner has to be joined. A team org keeps counting: it
    // has no `personalForUserId` at all (the schema leaves the field missing, and `null` here
    // matches missing too). A personal org counts only when its owner row is there and is not a
    // temp: `claim-temp` deletes the temp user and leaves its personal org behind, so an ownerless
    // personal org is the same anonymous-session residue, and a real deletion takes the org with it
    // (`purge.ts` deletes solo orgs outright), so nothing real is lost by requiring the owner.
    OrgModel.aggregate<{ n: number }>([
      { $match: { isDeleted: { $ne: true } } },
      { $lookup: { from: UserModel.collection.name, localField: "personalForUserId", foreignField: "_id", as: "owner" } },
      { $match: { $or: [{ personalForUserId: null }, { $and: [{ "owner.0": { $exists: true } }, { "owner.isTemp": { $ne: true } }] }] } },
      { $count: "n" },
    ]),
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
    // Same filter as `newUsers` above, or the chart would disagree with the tile it sits under.
    UserModel.aggregate<DayRow>([{ $match: { isTemp: { $ne: true }, createdAt: { $gte: since }, deletionPurgedAt: null } }, ...byDay("createdAt")]),
    AiRunModel.aggregate<DayRow>([{ $match: { createdDate: { $gte: since } } }, ...byDay("createdDate")]),
    CronHealthModel.find({}).select({ jobKey: 1, status: 1, lastRunAt: 1, lastError: 1 }).limit(50).lean(),
    UserModel.countDocuments({ deletionRequestedAt: { $ne: null }, deletionPurgedAt: null }),
    /**
     * Which plan limit actually stops people, and how many workspaces it stops.
     *
     * Eight routes have been writing `plan.limit_reached` with `{ limit, used, max }` since limits
     * shipped, and nothing has ever read them — so every decision about where to set a cap has been
     * made from reasoning rather than from the rows sitting in the database. Raising Free to 10
     * documents and 100 credits was one of those.
     *
     * Two numbers per limit, because they answer different questions: `hits` is how often the wall
     * is met, `workspaces` is how many distinct people meet it. A single workspace retrying twenty
     * times looks like demand in the first number and like one frustrated person in the second.
     */
    ActivityEventModel.aggregate([
      { $match: { type: "plan.limit_reached", createdDate: { $gte: since } } },
      { $group: { _id: { limit: "$meta.limit", orgId: "$orgId" }, hits: { $sum: 1 } } },
      { $group: { _id: "$_id.limit", hits: { $sum: "$hits" }, workspaces: { $sum: 1 } } },
      { $sort: { hits: -1 } },
    ]) as Promise<Array<{ _id?: unknown; hits?: number; workspaces?: number }>>,
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

  const planLimits = (Array.isArray(planLimitHits) ? planLimitHits : [])
    .map((r) => ({
      limit: typeof r?._id === "string" ? r._id : "unknown",
      hits: Number(r?.hits ?? 0),
      workspaces: Number(r?.workspaces ?? 0),
    }))
    .filter((r) => r.hits > 0);

  return NextResponse.json({
    ok: true,
    days,
    planLimits,
    totals: {
      users,
      orgs: Number(orgs?.[0]?.n ?? 0),
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
