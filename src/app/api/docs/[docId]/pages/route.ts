/**
 * Owner reading analytics for one document: people, total time, links and needs-attention rows on
 * every plan; on Pro also the page table, callouts and the per-person reading matrix.
 * Route: `/api/docs/:docId/pages?days=&shareId=&matrix=all`
 *
 * People are counted on the same basis as `/shareviews` (`viewerCount`), so the two endpoints agree
 * for the same `days` and `shareId`. Free responses are whitelisted by `toBasicReading`.
 */
import { NextResponse } from "next/server";

import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { applyTempUserHeaders } from "@/lib/gating/actor";
import { resolveDocAnalyticsAccess } from "@/lib/analytics/docAnalyticsAccess";
import { loadReadingCore } from "@/lib/analytics/loadReading";
import { MATRIX_ALL_LIMIT, MATRIX_ROW_LIMIT, buildReadingResponse, parseDaysParam } from "@/lib/analytics/reading";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "private, no-store" };

/** Handle GET requests. */
export async function GET(request: Request, ctx: { params: Promise<{ docId: string }> }) {
  return withMongoRequestLogging(request, async () => {
    const { docId } = await ctx.params;
    const access = await resolveDocAnalyticsAccess(request, docId);
    if (!access.ok) return access.response;
    const { actor, doc, plan, tier, daysLimit } = access;
    try {
      const url = new URL(request.url);
      const days = parseDaysParam(url.searchParams.get("days"), { plan, daysLimit });
      const shareId = (url.searchParams.get("shareId") ?? "").trim() || null;
      const matrixLimit = tier === "deep" && url.searchParams.get("matrix") === "all" ? MATRIX_ALL_LIMIT : MATRIX_ROW_LIMIT;
      const now = Date.now();

      const core = await loadReadingCore({ docId: doc._id, doc, days, now });
      // Archived or deleted links still resolve while their traffic exists; anything else is unknown.
      if (shareId && !core.links.some((l) => l.shareId === shareId) && !core.lastOpenedByShareId.has(shareId)) {
        return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE }), actor);
      }

      const body = buildReadingResponse(core, { tier, days, daysLimit, shareId, matrixLimit, now });
      return applyTempUserHeaders(NextResponse.json(body, { headers: NO_STORE }), actor);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return applyTempUserHeaders(NextResponse.json({ error: message }, { status: 500, headers: NO_STORE }), actor);
    }
  });
}
