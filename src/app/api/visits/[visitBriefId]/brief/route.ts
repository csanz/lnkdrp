/**
 * `POST /api/visits/:visitBriefId/brief` — the "Write the brief" button on a reader's page.
 *
 * A visit that closed as a recap (automatic briefs off, the day's ceiling, no credits) or failed
 * (the model gave up) kept its facts; this writes the brief for it now, for one credit, billed to
 * the member who clicked. It is the click the automatic gates exist to protect, so it goes past
 * `autoBriefEnabled` and the briefs-per-day ceiling; the credit gates still answer `402`
 * (`OUT_OF_CREDITS` / `DAILY_CREDIT_CAP`, the codes the out-of-credits modal reads). Pro only —
 * a Free workspace has no recap rows to click, and answers `402 plan_limit` if it finds one.
 *
 * Idempotent against the double click and the cron: the row is claimed before anything is spent,
 * so the second request answers `409` with the row's current state. No email is sent — the visit's
 * recap email already went — but the feed gets its `share.visit_briefed` row.
 */
import { NextResponse } from "next/server";

import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { forbidUnlessOrgRole } from "@/lib/orgs/requireOrgEditor";
import { forbidWaitlisted } from "@/lib/gating/waitlist";
import { DAILY_CAP_CODE, OUT_OF_CREDITS_CODE } from "@/lib/credits/errors";
import { writeVisitBriefNow } from "@/lib/visits/visitBriefs";

export const runtime = "nodejs";
// One model call with the document's page text attached; allow it to outlive the 90 s AI timeout.
export const maxDuration = 300;

/**
 *
 */
export async function POST(request: Request, ctx: { params: Promise<{ visitBriefId: string }> }) {
  const actor = await resolveActor(request);
  try {
    // Viewers must not trigger member-billed processing.
    const forbidden = await forbidUnlessOrgRole(actor);
    if (forbidden) return forbidden;
    const queued = await forbidWaitlisted(actor, "write a visit brief");
    if (queued) return queued;

    const { visitBriefId } = await ctx.params;
    const result = await writeVisitBriefNow({ visitBriefId, orgId: actor.orgId, userId: actor.userId });
    const json = (body: Record<string, unknown>, status = 200) => applyTempUserHeaders(NextResponse.json(body, { status }), actor);

    switch (result.status) {
      case "briefed":
        return json({ ok: true, visit: result.card, creditsCharged: result.creditsCharged });
      case "not_found":
        return json({ error: "Not found" }, 404);
      case "conflict":
        return json({ error: "This visit cannot be written now", status: result.current }, 409);
      case "plan":
        return json({ error: "Visit briefs are a Pro feature", code: "plan_limit", limit: "visit_briefs" }, 402);
      case "out_of_credits":
        return json({ error: "Out of credits", code: OUT_OF_CREDITS_CODE }, 402);
      case "daily_cap":
        return json({ error: "Daily credit cap reached", code: DAILY_CAP_CODE }, 402);
      case "model_failed":
        return json({ ok: false, error: "The brief could not be written; nothing was charged" }, 503);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return applyTempUserHeaders(NextResponse.json({ error: message }, { status: 500 }), actor);
  }
}
