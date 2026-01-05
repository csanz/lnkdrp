/**
 * API route for `POST /api/docs/:docId/changes/:changeId/rerun`.
 *
 * Regenerates a doc change summary (history diff) for a specific replacement record.
 * Customer-facing: charges credits (history action) and never returns internal telemetry.
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

export const runtime = "nodejs";

function isObjectId(id: string) {
  return Types.ObjectId.isValid(id);
}

export async function POST(request: Request, ctx: { params: Promise<{ docId: string; changeId: string }> }) {
  const actor = await resolveActor(request);
  try {
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
      const diff = await runDocChangeDiff({ previousText, newText, qualityTier });
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
      await failAndRefundLedger({ workspaceId: actor.orgId, ledgerId: reserved.ledgerId });
      const message = e instanceof Error ? e.message : "Diff generation failed";
      return applyTempUserHeaders(NextResponse.json({ error: message }, { status: 400 }), actor);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return applyTempUserHeaders(NextResponse.json({ error: message }, { status: 400 }), actor);
  }
}


