/**
 * API route for `/api/activity/summary`.
 *
 * The numbers above the `/activity` feed: what was DONE in this workspace over a window (documents
 * added, replaced, archived, links and projects created) and who did it (each agent client, then
 * everyone acting in the app). Deliberately not views, opens or downloads — those are performance
 * and live on `/metrics`; see `ACTIVITY_WORK_TYPES`.
 *
 * Counting happens in Mongo: one `$group` over `{ type, agent.client }` returns a handful of rows
 * (types × clients) that `summarizeActivityRows()` folds into both the counts and the donut, so the
 * page never pages through events to add them up. Org-scoped and role-checked exactly like the feed.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { ActivityEventModel } from "@/lib/models/ActivityEvent";
import { debugLog } from "@/lib/debug";
import { errorJson } from "@/lib/http/errorResponse";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { requireOrgRole } from "@/lib/orgs/requireOrgRole";
import { agentLabel } from "@/lib/activity/log";
import { windowStartUtc } from "@/lib/analytics/shareViewAggregates";
import {
  ACTIVITY_WORK_TYPES,
  buildActivitySeries,
  emptyCounts,
  summarizeActivityRows,
  type ActivityDayRow,
  type ActivityGroupRow,
} from "@/lib/activity/summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_DAYS = 30;
const MIN_DAYS = 1;
const MAX_DAYS = 365;

/** An empty summary, used for temp users and for a workspace with nothing in the window. */
function emptySummary(days: number, since: Date) {
  return {
    days,
    since: since.toISOString(),
    counts: emptyCounts(),
    actors: { total: 0, people: 0, agents: 0, slices: [] as [] },
    series: buildActivitySeries([], { since, days }),
  };
}

/**
 * `GET /api/activity/summary`
 *
 * Query: `days` (1–365, default 30). Response:
 * `{ days, since, counts: { docsAdded, docsReplaced, linksCreated, docsRemoved, projectsCreated },
 *    actors: { total, people, agents, slices: [{ key, kind, client, label, count }] },
 *    series: [{ day, total, people, agents, ...counts }] }` - one point per day, gaps filled.
 * `since` is midnight UTC of the window's first day, so it names `series[0].day` and the counts,
 * the donut and the chart are all measured over the same days.
 * Errors: 403 when the caller is not a workspace member; 400 for unexpected failures.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const daysRaw = Number(url.searchParams.get("days"));
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.floor(daysRaw))) : DEFAULT_DAYS;
  // Midnight UTC of the day `days - 1` days ago, the bound every other windowed aggregate here
  // takes from `windowStartUtc()` - and the exact span the chart draws. A rolling `Date.now() -
  // days * 24h` starts partway through a calendar day, while the day group below keys rows by their
  // UTC day, so the events in that leading sliver landed under a key `buildActivitySeries` never
  // emits: counted in the tiles and the donut, absent from every point of the line beneath them,
  // under a `since` naming a day the series does not contain. A reader would have read that as the
  // chart losing a day of work. Snapped, the match and the buckets cover the same days.
  const since = windowStartUtc(days);

  try {
    debugLog(2, "[api/activity/summary] GET", { days });

    const actor = await resolveActor(request);
    if (actor.kind !== "user") {
      // Same contract as the feed: a temp user has no workspace history, so zeros rather than a 401.
      return applyTempUserHeaders(
        NextResponse.json(emptySummary(days, since), { headers: { "cache-control": "no-store" } }),
        actor,
      );
    }

    const roleCheck = await requireOrgRole({ orgId: actor.orgId, userId: actor.userId, minRole: "viewer" });
    if (!roleCheck.ok) {
      return NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status });
    }

    await connectMongo();
    const orgId = new Types.ObjectId(actor.orgId);

    // `{ orgId, type, createdDate }` is an existing index; the group's cardinality is bounded by
    // the work-type list times the number of agent clients, so a page of rows never reaches Node.
    // Two groups over the same match: totals by type and client for the counts and the legend, and
    // one row per day and actor kind for the chart. Both stay small (types x clients, days x 2).
    const [grouped, byDay] = await Promise.all([
      ActivityEventModel.aggregate<{ _id: { type?: string; client?: string | null }; count?: number }>([
        { $match: { orgId, createdDate: { $gte: since }, type: { $in: ACTIVITY_WORK_TYPES } } },
        { $group: { _id: { type: "$type", client: "$agent.client" }, count: { $sum: 1 } } },
      ]),
      ActivityEventModel.aggregate<{ _id: { day?: string; type?: string; agent?: boolean }; count?: number }>([
        { $match: { orgId, createdDate: { $gte: since }, type: { $in: ACTIVITY_WORK_TYPES } } },
        {
          $group: {
            _id: {
              day: { $dateToString: { format: "%Y-%m-%d", date: "$createdDate", timezone: "UTC" } },
              type: "$type",
              agent: { $gt: [{ $strLenCP: { $ifNull: ["$agent.client", ""] } }, 0] },
            },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);
    const dayRows: ActivityDayRow[] = byDay.map((g) => ({
      day: typeof g._id?.day === "string" ? g._id.day : "",
      type: typeof g._id?.type === "string" ? g._id.type : "",
      agent: g._id?.agent === true,
      count: typeof g.count === "number" ? g.count : 0,
    }));

    const rows: ActivityGroupRow[] = grouped.map((g) => {
      const client = typeof g._id?.client === "string" && g._id.client.trim() ? g._id.client.trim() : null;
      return {
        type: typeof g._id?.type === "string" ? g._id.type : "",
        client,
        // "claude-code" -> "Claude Code", the same label the feed rows carry.
        label: client ? agentLabel({ client, version: null }) : null,
        count: typeof g.count === "number" ? g.count : 0,
      };
    });

    const summary = summarizeActivityRows(rows);
    return NextResponse.json(
      {
        days,
        since: since.toISOString(),
        counts: summary.counts,
        actors: summary.actors,
        series: buildActivitySeries(dayRows, { since, days }),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return errorJson(err, { status: 400, publicMessage: "Could not load activity totals", context: "[api/activity/summary] GET failed" });
  }
}
