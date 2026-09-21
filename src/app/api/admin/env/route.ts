/**
 * `GET /api/admin/env` — does this deployment's configuration actually work?
 *
 * Admin only, like every route under `/api/admin/*`. It returns statuses and never a value: the
 * worst version of this endpoint is one that helpfully shows you the secret it just validated.
 *
 * `no-store`, and deliberately not cached anywhere else either — the answer is about this moment,
 * and a stale "everything is fine" is worse than no answer.
 */
import { NextResponse } from "next/server";

import { errorJson } from "@/lib/http/errorResponse";
import { requireAdmin } from "@/lib/gating/requireAdmin";
import { runEnvPreflight, summarise } from "@/lib/preflight/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const gate = await requireAdmin(request);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
    const results = await runEnvPreflight();
    return NextResponse.json(
      { ok: true, summary: summarise(results), results, checkedAt: new Date().toISOString() },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return errorJson(err, { context: "[api/admin/env] failed", status: 500, publicMessage: "Could not check" });
  }
}
