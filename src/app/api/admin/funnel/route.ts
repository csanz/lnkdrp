/**
 * Admin API route: `GET /api/admin/funnel?weeks=8`
 *
 * The upgrade funnel per ISO week, for `/a/funnel`: workspaces at each step, the median days
 * from sign-up to the first wall, which limit is hit first. See `src/lib/funnel/report.ts`.
 */
import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/gating/requireAdmin";
import { loadFunnelReport } from "@/lib/funnel/report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The funnel report for the last `weeks` weeks (default 8, at most 26). */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const url = new URL(request.url);
  const raw = Number(url.searchParams.get("weeks") ?? "8");
  const weeks = Number.isFinite(raw) ? Math.min(26, Math.max(1, Math.floor(raw))) : 8;

  const report = await loadFunnelReport({ weeks });
  return NextResponse.json(report, { headers: { "cache-control": "no-store" } });
}
