/**
 * Admin API route: `GET /api/admin/cron-health`
 *
 * Returns latest cron health snapshots (written by cron endpoints).
 */
import { NextResponse } from "next/server";
import { connectMongo } from "@/lib/mongodb";
import { CronHealthModel } from "@/lib/models/CronHealth";
import { requireAdmin } from "@/lib/gating/requireAdmin";

export const runtime = "nodejs";
/**
 * As Positive Int (uses Number, isFinite, floor).
 */


/**
 *
 */
function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
}
/**
 * Handle GET requests.
 */


/**
 *
 */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const url = new URL(request.url);
  const limit = asPositiveInt(url.searchParams.get("limit")) ?? 50;

  await connectMongo();
  const items = await CronHealthModel.find({})
    .sort({ lastRunAt: -1, updatedDate: -1 })
    .limit(Math.min(limit, 200))
    .select({
      jobKey: 1,
      status: 1,
      lastStartedAt: 1,
      lastFinishedAt: 1,
      lastRunAt: 1,
      lastDurationMs: 1,
      lastParams: 1,
      lastResult: 1,
      lastErrorAt: 1,
      lastError: 1,
      createdDate: 1,
      updatedDate: 1,
    })
    .lean();

  return NextResponse.json({ ok: true, items });
}




