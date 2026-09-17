/**
 * API route for `/api/uploads/:uploadId/summary`.
 *
 * POST: write the AI summary for a version whose summary was skipped (out of credits, daily cap)
 * or failed. Costs 1 credit, reserved when the run starts. Returns 202 once processing is queued;
 * the doc updates over the realtime channel when the summary lands.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { forbidUnlessOrgRole } from "@/lib/orgs/requireOrgEditor";
import { getCreditsSnapshot } from "@/lib/credits/snapshot";
import { OUT_OF_CREDITS_CODE } from "@/lib/credits/errors";
import { creditsForRun } from "@/lib/credits/schedule";
import { queueSummaryRerun } from "@/lib/uploads/summaryRerun";

export const runtime = "nodejs";

export async function POST(request: Request, ctx: { params: Promise<{ uploadId: string }> }) {
  const { uploadId } = await ctx.params;
  const actor = await resolveActor(request);
  const forbidden = await forbidUnlessOrgRole(actor);
  if (forbidden) return forbidden;
  if (!Types.ObjectId.isValid(uploadId)) {
    return applyTempUserHeaders(NextResponse.json({ error: "Invalid uploadId" }, { status: 400 }), actor);
  }

  const creditsNeeded = creditsForRun({ actionType: "summary", qualityTier: "basic" });
  try {
    const snap = await getCreditsSnapshot({ workspaceId: actor.orgId });
    // On Pro with on-demand, a run can go ahead past the credits held; `null` means no on-demand cap.
    if (snap.blocked || (snap.spendableRemaining !== null && snap.spendableRemaining < creditsNeeded)) {
      return applyTempUserHeaders(
        NextResponse.json(
          { error: "Out of credits", code: OUT_OF_CREDITS_CODE, creditsNeeded, creditsRemaining: snap.creditsRemaining },
          { status: 402 },
        ),
        actor,
      );
    }
  } catch {
    // Best-effort preflight; the reservation inside the job is the real gate.
  }

  const res = await queueSummaryRerun({ uploadId, origin: new URL(request.url).origin, orgId: actor.orgId });
  if (!res.ok) {
    return applyTempUserHeaders(NextResponse.json({ error: res.error, code: res.code }, { status: res.status }), actor);
  }
  return applyTempUserHeaders(NextResponse.json({ ok: true, creditsNeeded }, { status: 202 }), actor);
}
