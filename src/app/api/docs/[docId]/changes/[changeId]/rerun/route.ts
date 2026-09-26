/**
 * API route for `POST /api/docs/:docId/changes/:changeId/rerun`.
 *
 * Regenerates a doc change summary (history diff) for a specific replacement record.
 * Customer-facing: charges credits (history action) and never returns internal telemetry.
 *
 * Credit-gated on every plan (no plan gate): a Free workspace with credits can regenerate a compare;
 * with too few it gets `402 OUT_OF_CREDITS` (or `DAILY_CREDIT_CAP`) before any work runs.
 */
import crypto from "node:crypto";

import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { buildDocMatch } from "@/lib/docs/docMatch";
import { lockedHomeExclusionFor } from "@/lib/projects/lockScope";
import { DocChangeModel } from "@/lib/models/DocChange";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { runDocChangeDiff, normalizeForCompare, type DocChangeDiffUsage } from "@/lib/ai/docChangeDiff";
import { isNoChangeSummary, NO_CHANGE_SUMMARY } from "@/lib/ai/docChangeSummary";
import { reserveCreditsOrThrow, markLedgerCharged, failAndRefundLedger } from "@/lib/credits/creditService";
import type { QualityTier } from "@/lib/credits/types";
import { idempotencyKeyFromRequest } from "@/lib/credits/idempotency";
import { DAILY_CAP_CODE, isDailyCapError, isOutOfCreditsError, OUT_OF_CREDITS_CODE } from "@/lib/credits/errors";
import { forbidUnlessOrgRole } from "@/lib/orgs/requireOrgEditor";
import { forbidWaitlisted } from "@/lib/gating/waitlist";
import { UploadModel } from "@/lib/models/Upload";
import { attachPageContext, loadChangedPages, type ChangedPage } from "@/lib/history/changedPages";

export const runtime = "nodejs";
// Diff generation can take a while for long docs; allow the function to outlive the 90s AI timeout.
export const maxDuration = 300;

/**
 * Shape a compare's usage for the credit ledger.
 *
 * The ledger's store spreads whatever it is handed straight onto the document, and the ledger is a
 * strict schema - so a nested object under a key it does not declare is dropped on save without a
 * word. An earlier version passed `{ compare: usage }` and recorded nothing at all, while reading
 * exactly like it worked. These are the ledger's own telemetry paths.
 */
function compareTelemetry(u: DocChangeDiffUsage | null): Record<string, unknown> | null {
  if (!u) return null;
  const input = typeof u.inputTokens === "number" ? u.inputTokens : null;
  const output = typeof u.outputTokens === "number" ? u.outputTokens : null;
  return {
    provider: "openai",
    modelRoute: u.model,
    promptTokens: input,
    completionTokens: output,
    totalTokens: input !== null && output !== null ? input + output : null,
    imagesAttached: u.imagesAttached,
    pagesAttached: u.pagesAttached,
  };
}

/**
 * The idempotency key this rerun reserves under.
 *
 * What went wrong: the caller's `x-idempotency-key` was passed to `reserveCreditsOrThrow`
 * verbatim. Reservations are idempotent on their key and the lookup happens *before* every balance
 * and daily-cap check in `serviceCore`, so the caller chose which ledger row this request settled
 * on. Sending `history:auto:<docId>:to:<version>` - the automatic replacement compare's own key,
 * which is derivable from anything the history page already shows - landed on a row the workspace
 * had already paid for, and the route then ran the model against it for free, zero balance or not.
 *
 * The fix keeps the header (it is what makes a retried request one charge rather than two) but
 * treats it as a discriminator *inside* a namespace the caller cannot leave: the document, the
 * change, the version pair and the tier are the server's own, so a key can only ever address this
 * one rerun of this one version pair at this one price. Namespacing rather than deriving outright
 * is deliberate: a fully derived key would make the second press of Regenerate a silent no-op that
 * returns the first compare, and producing a fresh compare is the button's entire purpose.
 *
 * The caller's string is hashed, not concatenated: it is untrusted input that ends up in a Mongo
 * index, and a hash bounds its length and character set without weakening the namespace.
 * With no header there is nothing to dedupe on, so each call gets its own run, as before.
 */
function rerunIdempotencyKey(params: {
  docId: string;
  changeId: string;
  fromVersion: unknown;
  toVersion: unknown;
  qualityTier: QualityTier;
  callerKey: string | null;
}): string {
  const version = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? String(Math.floor(v)) : "x");
  const scope = [
    "history:rerun",
    params.docId,
    params.changeId,
    `v${version(params.fromVersion)}-${version(params.toVersion)}`,
    params.qualityTier,
  ].join(":");
  const suffix = params.callerKey
    ? `c:${crypto.createHash("sha256").update(params.callerKey).digest("hex").slice(0, 32)}`
    : `r:${crypto.randomUUID()}`;
  return `${scope}:${suffix}`;
}

/**
 * Reserve credits for one rerun attempt, never settling a ledger row that holds no credits.
 *
 * Mirrors `reserveForAttempt` in `src/app/api/uploads/[uploadId]/process/route.ts`. A reservation
 * is idempotent on its key, so a replay gets the earlier attempt's row back: `pending` is the
 * normal case and `charged` means that attempt already paid (the caller must neither redo the work
 * nor charge again). A `refunded` or `failed` row - which is what a failed run, or one that never
 * reached the model, leaves behind - holds no credits at all, so marking it charged would bill
 * credits the balance never gave up;
 * this reserves again under a retry-suffixed key instead.
 */
async function reserveForAttempt(params: Parameters<typeof reserveCreditsOrThrow>[0]) {
  const first = await reserveCreditsOrThrow(params);
  if (first.status === "pending" || first.status === "charged") return first;
  return await reserveCreditsOrThrow({ ...params, idempotencyKey: `${params.idempotencyKey}:retry:${Date.now().toString(36)}` });
}

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

/**
 * Regenerate the AI compare for one version pair, on the workspace's credits.
 *
 * Two identical versions are answered before anything is reserved, so they cost nothing. Otherwise
 * this reserves before the model runs and settles at the reserved amount; a replayed idempotency
 * key returns the earlier run's result without calling the model or charging again, and a run that
 * never reached the model is refunded.
 */
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

    // Authorization: doc must belong to the actor's org (with legacy personal-org fallback), and its
    // home must not be a locked room this person holds no grant for. The lock is access rather than
    // discovery (docs/prds/lnkdrp-locked-projects.md, decision 11), so it is this by-id check and not
    // a listing filter that keeps a pasted document id out of a private room.
    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
    const lockedExclusion = await lockedHomeExclusionFor(orgId, actor.userId, request);
    const docObjectId = new Types.ObjectId(docId);
    const docExists = await DocModel.exists(buildDocMatch(docObjectId, orgId, legacyUserId, allowLegacyByUserId, lockedExclusion));
    if (!docExists) return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);

    // By docId alone, as the list route reads them: document access is checked above, and older
    // rows carry a missing or stale orgId (legacy, backfills, workspace moves) that would make a
    // change the list shows unrerunnable here.
    const change = await DocChangeModel.findOne({
      _id: new Types.ObjectId(changeId),
      docId: docObjectId,
    })
      .select({ _id: 1, docId: 1, previousText: 1, newText: 1, fromVersion: 1, toVersion: 1, toUploadId: 1 })
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
    /** Pages that changed in total, before the context cap. See `computeChangedPages`. */
    let totalChangedPages: number | null = null;
    /** Page counts for both versions; see the no-change short-circuit in `runDocChangeDiff`. */
    let previousPageCount: number | null = null;
    let newPageCount: number | null = null;
    try {
      // Resolve the previous version by number: older rows stored the new upload as `fromUploadId`.
      const fromVersion = Number((change as { fromVersion?: unknown }).fromVersion);
      const toUploadId = (change as { toUploadId?: unknown }).toUploadId;
      if (Number.isFinite(fromVersion) && fromVersion >= 1 && toUploadId && Types.ObjectId.isValid(String(toUploadId))) {
        const [prevUpload, newUpload] = await Promise.all([
          UploadModel.findOne({ docId: docObjectId, version: fromVersion, isDeleted: { $ne: true } })
            .select({ blobUrl: 1, slideNodes: 1, "metadata.pages": 1 })
            .lean(),
          UploadModel.findById(String(toUploadId)).select({ blobUrl: 1, slideNodes: 1, "metadata.pages": 1 }).lean(),
        ]);
        /** See the no-change short-circuit in `runDocChangeDiff`: a moved page count settles it. */
        const countPages = (row: unknown) => {
          const m = (row as { metadata?: { pages?: unknown } } | null)?.metadata?.pages;
          if (typeof m === "number" && Number.isFinite(m) && m > 0) return Math.floor(m);
          const slides = (row as { slideNodes?: unknown } | null)?.slideNodes;
          return Array.isArray(slides) && slides.length ? slides.length : null;
        };
        previousPageCount = countPages(prevUpload);
        newPageCount = countPages(newUpload);
        changedPages = await loadChangedPages({
          prevUpload,
          newUpload,
          onTotal: (n) => {
            totalChangedPages = n;
          },
        });
      }
    } catch {
      changedPages = [];
    }

    /**
     * "Nothing changed is free" is decided here, before any reservation - not refunded afterwards.
     *
     * What went wrong: the free outcome was recognised *after* the run, from
     * `isNoChangeSummary(diff.summary)`, and `runDocChangeDiff` returns that exact summary from two
     * places. One is the pre-model short-circuit, which costs nothing; the other is after
     * `generateObject` has run and been paid for, because the prompt itself instructs the model to
     * answer with that sentence when it sees no real content difference. Refunding both made a real
     * OpenAI call cost the workspace nothing, and a refunded reservation is not counted by the
     * daily or monthly caps either (`mongooseStore` sums only `pending` and `charged` rows), so the
     * spend was not merely free but invisible. Every press of Regenerate mints a fresh key, so it
     * was unbounded.
     *
     * This mirrors `nothingChanged` in `src/app/api/uploads/[uploadId]/process/route.ts`: a
     * pre-reserve text check, so there is no reserve/refund round trip and the cap sums stay
     * honest. The page-count test is part of it because `runDocChangeDiff` treats a moved page
     * count as a real change however the text compares - without it this would answer "no changes"
     * for a version that gained pages, where the callee would have called the model. Given the
     * empty-text guard above, these three conditions are exactly the callee's own short-circuit, so
     * the two sides cannot disagree about which runs are free.
     */
    const pageCountMoved =
      previousPageCount !== null && newPageCount !== null && previousPageCount !== newPageCount;
    if (
      !pageCountMoved &&
      normalizeForCompare(previousText) === normalizeForCompare(newText) &&
      !changedPages.some((p) => p.imageChanged === true)
    ) {
      // The record is still stored, so history reads "no changes" rather than staying empty.
      await DocChangeModel.updateOne(
        { _id: new Types.ObjectId(changeId) },
        {
          $set: {
            diff: attachPageContext({ summary: NO_CHANGE_SUMMARY, changes: [], pagesThatChanged: [] }, changedPages),
            ...(totalChangedPages === null ? {} : { changedPageCount: totalChangedPages }),
          },
        },
      );
      return applyTempUserHeaders(NextResponse.json({ ok: true, noChange: true, creditsCharged: 0 }), actor);
    }

    const idKey = rerunIdempotencyKey({
      docId,
      changeId,
      fromVersion: (change as { fromVersion?: unknown }).fromVersion,
      toVersion: (change as { toVersion?: unknown }).toVersion,
      qualityTier,
      callerKey: idempotencyKeyFromRequest(request),
    });

    let reserved: Awaited<ReturnType<typeof reserveCreditsOrThrow>>;
    try {
      reserved = await reserveForAttempt({
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

    // This exact request already ran and was already paid for: return its result rather than the
    // model's. The check the route was missing - without it a replayed key reached the model past
    // every balance and daily-cap check (those all sit behind the existing-row short-circuit in
    // `serviceCore`), so one spent key bought unlimited compares, including from a workspace with
    // nothing left. The diff it produced is already on the DocChange row this request names.
    if (reserved.status === "charged") {
      return applyTempUserHeaders(
        NextResponse.json({ ok: true, reused: true, creditsCharged: 0 }),
        actor,
      );
    }

    try {
      /**
       * Usage in an object, not a bare `let`: TypeScript narrows a `let` initialised to `null` and
       * only ever assigned inside a callback back to `null` at every later read, so `usage !== null`
       * below would be a compile error rather than the test it looks like. `process/route.ts` holds
       * `compareRun` the same way for the same reason.
       */
      const run: { usage: DocChangeDiffUsage | null } = { usage: null };
      const diff = attachPageContext(
        await runDocChangeDiff({
          previousText,
          newText,
          changedPages,
          previousPageCount,
          newPageCount,
          qualityTier,
          abortSignal: AbortSignal.timeout(DIFF_TIMEOUT_MS),
          onUsage: (u) => {
            run.usage = u;
          },
        }),
        changedPages,
      );
      if (!diff) {
        await failAndRefundLedger({ workspaceId: actor.orgId, ledgerId: reserved.ledgerId });
        return applyTempUserHeaders(NextResponse.json({ ok: false, error: "AI compare unavailable" }, { status: 503 }), actor);
      }

      await DocChangeModel.updateOne(
        { _id: new Types.ObjectId(changeId) },
        { $set: { diff, ...(totalChangedPages === null ? {} : { changedPageCount: totalChangedPages }) } },
      );

      /**
       * Refund only when no model call happened, never because of what the summary says.
       *
       * The pre-reserve test above decides which runs are free, but it predicts the callee rather
       * than observing it, and usage is the one signal the two sides cannot disagree about: it is
       * reported by `runDocChangeDiff` itself, after `generateObject` returns and before the result
       * is shaped. `null` here means the callee short-circuited after all (a condition this route
       * did not see, or one added to it later) - a real record that cost nothing, so the
       * reservation goes straight back. It is deliberately NOT a summary test: the compare prompt
       * tells the model to answer with the no-change sentence when it finds no real content
       * difference, so reading that sentence as "free" handed back the credits for a paid run and
       * made the spend invisible to the daily and monthly caps as well. Same rule as
       * `compareChargeable` in `src/app/api/uploads/[uploadId]/process/route.ts`.
       */
      if (run.usage === null) {
        await failAndRefundLedger({ workspaceId: actor.orgId, ledgerId: reserved.ledgerId });
        return applyTempUserHeaders(NextResponse.json({ ok: true, noChange: true, creditsCharged: 0 }), actor);
      }

      /**
       * Settle at what the reservation took, never at this request's price.
       *
       * `creditsForRun` for the tier in the body is what *this* attempt would cost; the row being
       * settled may have been reserved at another price (found under the retry-suffixed key above,
       * or taken before the schedule moved). Charging the recomputed number wrote a ledger row the
       * balance never matched - 2 credits out of the buckets, 12 into `creditsCharged` - and
       * `usedThisCycle` and `creditsRemaining` then drift apart permanently.
       */
      await markLedgerCharged({
        workspaceId: actor.orgId,
        ledgerId: reserved.ledgerId,
        creditsCharged: reserved.creditsReserved,
        telemetry: compareTelemetry(run.usage),
      });
      // `noChange` is reported so the client can label the row, but it does not change the price:
      // the model ran, so this run is charged whatever sentence it came back with.
      const noChange = isNoChangeSummary((diff as { summary?: unknown }).summary);
      return applyTempUserHeaders(
        NextResponse.json({ ok: true, creditsCharged: reserved.creditsReserved, ...(noChange ? { noChange: true } : {}) }),
        actor,
      );
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


