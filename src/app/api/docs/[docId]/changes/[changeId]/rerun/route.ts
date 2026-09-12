/**
 * API route for `POST /api/docs/:docId/changes/:changeId/rerun`.
 *
 * Regenerates a doc change summary (history diff) for a specific replacement record.
 * Customer-facing: charges credits (history action) and never returns internal telemetry.
 *
 * Plan gate: the AI compare is a Pro feature (`checkLimit(orgId, "version_history")`). Free
 * workspaces get a `402 plan_limit` before any credits are reserved.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { DocChangeModel } from "@/lib/models/DocChange";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { runDocChangeDiff } from "@/lib/ai/docChangeDiff";
import { reserveCreditsOrThrow, markLedgerCharged, failAndRefundLedger } from "@/lib/credits/creditService";
import { creditsForRun } from "@/lib/credits/schedule";
import { idempotencyKeyFromRequest, generateIdempotencyKey } from "@/lib/credits/idempotency";
import { isOutOfCreditsError, OUT_OF_CREDITS_CODE } from "@/lib/credits/errors";
import { checkLimit, planLimitResponse } from "@/lib/billing/planLimits";
import { recordActivity } from "@/lib/activity/log";
import { forbidUnlessOrgRole } from "@/lib/orgs/requireOrgEditor";

export const runtime = "nodejs";
// Diff generation can take a while for long docs; allow the function to outlive the 90s AI timeout.
export const maxDuration = 300;

/** Hard timeout for the AI diff call; on abort the reservation is refunded and a 503 is returned. */
const DIFF_TIMEOUT_MS = 90_000;

function isAbortError(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") return true;
  const msg = e instanceof Error ? e.message : "";
  return /aborted|timed? ?out/i.test(msg);
}

function isObjectId(id: string) {
  return Types.ObjectId.isValid(id);
}

export async function POST(request: Request, ctx: { params: Promise<{ docId: string; changeId: string }> }) {
  const actor = await resolveActor(request);
  try {
    // Viewers must not trigger owner-billed processing.
    const forbidden = await forbidUnlessOrgRole(actor);
    if (forbidden) return forbidden;
    const { docId, changeId } = await ctx.params;
    if (!isObjectId(docId)) return NextResponse.json({ error: "Invalid docId" }, { status: 400 });
    if (!isObjectId(changeId)) return NextResponse.json({ error: "Invalid changeId" }, { status: 400 });

    const body = (await request.json().catch(() => null)) as { qualityTier?: unknown } | null;
    const tierRaw = typeof body?.qualityTier === "string" ? body.qualityTier.trim().toLowerCase() : "";
    const qualityTier =
      tierRaw === "advanced" ? ("advanced" as const) : tierRaw === "basic" ? ("basic" as const) : ("standard" as const);

    await connectMongo();

    // Authorization: doc must belong to the actor's org (with legacy personal-org fallback).
    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
    const docObjectId = new Types.ObjectId(docId);
    const docExists = await DocModel.exists({
      ...(allowLegacyByUserId
        ? {
            $or: [
              { _id: docObjectId, orgId, isDeleted: { $ne: true } },
              {
                _id: docObjectId,
                userId: legacyUserId,
                isDeleted: { $ne: true },
                $or: [{ orgId: { $exists: false } }, { orgId: null }],
              },
            ],
          }
        : { _id: docObjectId, orgId, isDeleted: { $ne: true } }),
    });
    if (!docExists) return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);

    const change = await DocChangeModel.findOne({
      _id: new Types.ObjectId(changeId),
      docId: docObjectId,
      ...(allowLegacyByUserId ? {} : { orgId }),
    })
      .select({ _id: 1, docId: 1, previousText: 1, newText: 1 })
      .lean();
    if (!change) return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);

    const previousText = (change as any).previousText?.toString?.() ?? "";
    const newText = (change as any).newText?.toString?.() ?? "";
    if (!previousText.trim() || !newText.trim()) {
      return applyTempUserHeaders(NextResponse.json({ error: "Missing extracted text for diff" }, { status: 400 }), actor);
    }

    // Pro feature gate: decided before any credits are reserved so Free never pays for a compare.
    const planCheck = await checkLimit(actor.orgId, "version_history");
    if (!planCheck.ok) {
      void recordActivity({
        orgId: actor.orgId,
        userId: actor.userId,
        actorKind: actor.kind,
        type: "plan.limit_reached",
        docId: docObjectId,
        meta: { limit: planCheck.limit, used: planCheck.used, max: planCheck.max },
        request,
      });
      return applyTempUserHeaders(planLimitResponse(planCheck), actor);
    }

    const idKey = idempotencyKeyFromRequest(request) ?? generateIdempotencyKey(`history:${docId}:${changeId}`);
    const credits = creditsForRun({ actionType: "history", qualityTier });

    let reserved: Awaited<ReturnType<typeof reserveCreditsOrThrow>>;
    try {
      reserved = await reserveCreditsOrThrow({
        workspaceId: actor.orgId,
        userId: actor.userId,
        docId,
        actionType: "history",
        qualityTier,
        idempotencyKey: idKey,
      });
    } catch (e) {
      if (isOutOfCreditsError(e)) {
        return applyTempUserHeaders(
          NextResponse.json({ error: "Out of credits", code: OUT_OF_CREDITS_CODE }, { status: 402 }),
          actor,
        );
      }
      throw e;
    }

    try {
      const diff = await runDocChangeDiff({
        previousText,
        newText,
        qualityTier,
        abortSignal: AbortSignal.timeout(DIFF_TIMEOUT_MS),
      });
      if (!diff) {
        await failAndRefundLedger({ workspaceId: actor.orgId, ledgerId: reserved.ledgerId });
        return applyTempUserHeaders(NextResponse.json({ ok: false, error: "Diff generation unavailable" }, { status: 503 }), actor);
      }

      await DocChangeModel.updateOne(
        { _id: new Types.ObjectId(changeId) },
        { $set: { diff } },
      );

      await markLedgerCharged({ workspaceId: actor.orgId, ledgerId: reserved.ledgerId, creditsCharged: credits });
      return applyTempUserHeaders(NextResponse.json({ ok: true }), actor);
    } catch (e) {
      // Any failure (including the 90s abort) refunds the reservation; nothing was charged.
      await failAndRefundLedger({ workspaceId: actor.orgId, ledgerId: reserved.ledgerId });
      if (isAbortError(e)) {
        return applyTempUserHeaders(
          NextResponse.json({ ok: false, error: "Diff generation timed out", code: "DIFF_TIMEOUT" }, { status: 503 }),
          actor,
        );
      }
      const message = e instanceof Error ? e.message : "Diff generation failed";
      return applyTempUserHeaders(NextResponse.json({ error: message }, { status: 400 }), actor);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return applyTempUserHeaders(NextResponse.json({ error: message }, { status: 400 }), actor);
  }
}


