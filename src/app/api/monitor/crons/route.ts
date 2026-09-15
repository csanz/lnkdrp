/**
 * `GET /api/monitor/crons` — cron health an uptime monitor can actually watch.
 *
 * Nothing alerts when a cron stops. `/a/cron-health` and `/api/admin/cron-health` both need an
 * admin session, which a monitor cannot hold, so the only way to notice a dead job was for a person
 * to remember to look. This route answers the same question with a status code: **200 when every
 * job is healthy, 503 when any is not**, which is the one thing every uptime monitor already knows
 * how to alert on. The JSON body says which job and why, for whoever reads the alert.
 *
 * Auth is `Authorization: Bearer $CRON_SECRET` (`requireCronAuth`, the same secret and the same
 * header the schedules already use), not an admin session — the operator configuring the monitor
 * has that secret in hand. It is not public: `lastError` can carry internal detail.
 *
 * Expect red for the first hour of a new deployment: a job that has never run is `never-run`, which
 * is deliberate, because the alternative is a monitor that stays green for a cron that never fired.
 * Point the monitor at it once `/a/cron-health` shows the first full round.
 *
 * `?strict=0` reports the same body with a 200 whatever the states, for reading it by hand.
 */
import { NextResponse } from "next/server";

import { connectMongo } from "@/lib/mongodb";
import { requireCronAuth } from "@/lib/cron/auth";
import { CronHealthModel } from "@/lib/models/CronHealth";
import { judgeCronHealth } from "@/lib/cron/jobs";
import { errorJson } from "@/lib/http/errorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = requireCronAuth(request);
  if (unauthorized) return unauthorized;

  try {
    await connectMongo();
    const rows = await CronHealthModel.find({})
      .select({ jobKey: 1, status: 1, lastRunAt: 1, lastStartedAt: 1, lastDurationMs: 1, lastError: 1 })
      .lean();

    const { healthy, jobs } = judgeCronHealth({ rows, now: Date.now() });
    const unhealthy = jobs.filter((j) => j.state !== "ok").map((j) => j.jobKey);
    const strict = (new URL(request.url).searchParams.get("strict") ?? "") !== "0";

    return NextResponse.json(
      { ok: healthy, checkedAt: new Date().toISOString(), unhealthy, jobs },
      { status: healthy || !strict ? 200 : 503, headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    // A monitor must go red when the check itself cannot run, so this is 503 rather than 500 —
    // same alert, and the reason is in the body.
    return errorJson(err, {
      status: 503,
      publicMessage: "Could not read cron health",
      context: "[api/monitor/crons] GET failed",
    });
  }
}
