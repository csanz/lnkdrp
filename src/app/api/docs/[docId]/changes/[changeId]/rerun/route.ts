/**
 * API route for `POST /api/docs/:docId/changes/:changeId/rerun`.
 *
 * Regenerates a doc change summary (history diff) for a specific replacement record.
 * Customer-facing: charges credits (history action) and never returns internal telemetry.
 *
 * Credit-gated on every plan (no plan gate): a Free workspace with credits can regenerate a compare;
 * with too few it gets `402 OUT_OF_CREDITS` (or `DAILY_CREDIT_CAP`) before any work runs.
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
import { DAILY_CAP_CODE, isDailyCapError, isOutOfCreditsError, OUT_OF_CREDITS_CODE } from "@/lib/credits/errors";
import { forbidUnlessOrgRole } from "@/lib/orgs/requireOrgEditor";
import { forbidWaitlisted } from "@/lib/gating/waitlist";
import { UploadModel } from "@/lib/models/Upload";
import { attachPageContext, loadChangedPages, type ChangedPage } from "@/lib/history/changedPages";

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
    // The queue is a gate on the API, not a redirect on one page layout. `(app)/layout.tsx` sent a
    // queued account to /waitlist, which is a decoration: the browser could still call this route
    // directly, and so could an `lnk_` key. See src/lib/gating/waitlist.ts.
    // The header above says this route is credit-gated on every plan — but a credit gate only asks
    // whether the workspace can pay, never whether the account was let in, and a queued person's
    // free credits are still the operator's AI spend. Refuse here, before `reserveCreditsOrThrow`.
    const queued = await forbidWaitlisted(actor, "rerun a comparison");
    if (queued) return queued;
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
      .select({ _id: 1, docId: 1, previousText: 1, newText: 1, fromVersion: 1, toUploadId: 1 })
      .lean();
    if (!change) return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);

    const previousText = (change as any).previousText?.toString?.() ?? "";
    const newText = (change as any).newText?.toString?.() ?? "";
    if (!previousText.trim() || !newText.trim()) {
      return applyTempUserHeaders(NextResponse.json({ error: "Missing extracted text for diff" }, { status: 400 }), actor);
    }

    // Same page-level context as the automatic compare (changed pages with both versions' text and
    // thumbnails), built before any credits are reserved. Best-effort: full text only on failure.
    let changedPages: ChangedPage[] = [];
    try {
      // Resolve the previous version by number: older rows stored the new upload as `fromUploadId`.
      const fromVersion = Number((change as { fromVersion?: unknown }).fromVersion);
      const toUploadId = (change as { toUploadId?: unknown }).toUploadId;
      if (Number.isFinite(fromVersion) && fromVersion >= 1 && toUploadId && Types.ObjectId.isValid(String(toUploadId))) {
        const [prevUpload, newUpload] = await Promise.all([
          UploadModel.findOne({ docId: docObjectId, version: fromVersion, isDeleted: { $ne: true } })
            .select({ blobUrl: 1, slideNodes: 1 })
            .lean(),
          UploadModel.findById(String(toUploadId)).select({ blobUrl: 1, slideNodes: 1 }).lean(),
        ]);
        changedPages = await loadChangedPages({ prevUpload, newUpload });
      }
    } catch {
      changedPages = [];
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
        const dailyCap = isDailyCapError(e);
        return applyTempUserHeaders(
          NextResponse.json(
            { error: dailyCap ? "Daily credit cap reached" : "Out of credits", code: dailyCap ? DAILY_CAP_CODE : OUT_OF_CREDITS_CODE },
            { status: 402 },
          ),
          actor,
        );
      }
      throw e;
    }

    try {
      const diff = attachPageContext(
        await runDocChangeDiff({
          previousText,
          newText,
          changedPages,
          qualityTier,
          abortSignal: AbortSignal.timeout(DIFF_TIMEOUT_MS),
        }),
        changedPages,
      );
      if (!diff) {
        await failAndRefundLedger({ workspaceId: actor.orgId, ledgerId: reserved.ledgerId });
        return applyTempUserHeaders(NextResponse.json({ ok: false, error: "AI compare unavailable" }, { status: 503 }), actor);
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
          NextResponse.json({ ok: false, error: "AI compare timed out", code: "DIFF_TIMEOUT" }, { status: 503 }),
          actor,
        );
      }
      const message = e instanceof Error ? e.message : "AI compare failed";
      return applyTempUserHeaders(NextResponse.json({ error: message }, { status: 400 }), actor);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return applyTempUserHeaders(NextResponse.json({ error: message }, { status: 400 }), actor);
  }
}


