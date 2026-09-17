/**
 * One person's reading of a document: verdict, facts, page-by-page time and their visits.
 * Route: `/api/docs/:docId/pages/person?id=&days=`
 *
 * Pro only (`analytics_history`, 402 on Free). `id` is an encoded person id (link + viewer key,
 * never an email); a malformed id is 400 and a person with no activity in the range is 404.
 */
import { NextResponse } from "next/server";

import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { applyTempUserHeaders } from "@/lib/gating/actor";
import { checkLimit, planLimitResponse } from "@/lib/billing/planLimits";
import { resolveDocAnalyticsAccess } from "@/lib/analytics/docAnalyticsAccess";
import { loadReadingCore } from "@/lib/analytics/loadReading";
import { buildPersonResponse, decodePersonId, parseDaysParam } from "@/lib/analytics/reading";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "private, no-store" };

/** Handle GET requests. */
export async function GET(request: Request, ctx: { params: Promise<{ docId: string }> }) {
  return withMongoRequestLogging(request, async () => {
    const { docId } = await ctx.params;
    const access = await resolveDocAnalyticsAccess(request, docId);
    if (!access.ok) return access.response;
    const { actor, doc, plan, daysLimit } = access;
    try {
      if (plan !== "pro") {
        const gate = await checkLimit(doc.orgId ?? actor.orgId, "analytics_history");
        if (!gate.ok) return applyTempUserHeaders(planLimitResponse(gate), actor);
      }

      const url = new URL(request.url);
      const parts = decodePersonId(url.searchParams.get("id"));
      if (!parts) {
        return applyTempUserHeaders(NextResponse.json({ error: "Invalid person id" }, { status: 400, headers: NO_STORE }), actor);
      }
      const days = parseDaysParam(url.searchParams.get("days"), { plan, daysLimit });
      const now = Date.now();

      const core = await loadReadingCore({ docId: doc._id, doc, days, now });
      const key = `${parts.shareId}|${parts.kind}:${parts.id}`;
      const person = core.people.find((p) => p.key === key);
      if (!person) {
        return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE }), actor);
      }

      const body = buildPersonResponse(core, person, { days, now });
      return applyTempUserHeaders(NextResponse.json(body, { headers: NO_STORE }), actor);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return applyTempUserHeaders(NextResponse.json({ error: message }, { status: 500, headers: NO_STORE }), actor);
    }
  });
}
