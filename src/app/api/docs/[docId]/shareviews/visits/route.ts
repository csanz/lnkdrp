/**
 * Owner doc share-view visits API (per-visit breakdown for a viewer).
 * Route: `/api/docs/:docId/shareviews/visits`
 *
 * Deep analytics: Free workspaces get `402 plan_limit` (`analytics_history`); Pro gets the visits.
 *
 * `?shareId=<slug>` scopes the timeline to one link of the document, exactly as on
 * `/api/docs/:docId/shareviews`. Without it the answer covers every link. The same browser
 * (`botIdHash` lives in localStorage) opens every link of a document, so an unscoped answer under
 * a link filter attributed other links' sessions to the selected one.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { PROJECT_LINK_FILTER, ShareLinkModel, type ShareLink } from "@/lib/models/ShareLink";
import { projectLinkSlugsForDocs } from "@/lib/analytics/docScope";
import { ShareVisitModel } from "@/lib/models/ShareVisit";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { checkLimit, planLimitResponse } from "@/lib/billing/planLimits";
import { RECIPIENT_ONLY_MATCH, shareIdClause } from "@/lib/analytics/shareViewAggregates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
}

export async function GET(request: Request, ctx: { params: Promise<{ docId: string }> }) {
  const actor = await resolveActor(request);
  try {
    const url = new URL(request.url);
    const { docId } = await ctx.params;
    if (!Types.ObjectId.isValid(docId)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid docId" }, { status: 400 }), actor);
    }

    const kindRaw = url.searchParams.get("kind");
    const kind = kindRaw === "authed" || kindRaw === "anon" ? kindRaw : null;
    if (!kind) {
      return applyTempUserHeaders(NextResponse.json({ error: "Missing kind" }, { status: 400 }), actor);
    }

    const userId = url.searchParams.get("userId");
    const botIdHash = url.searchParams.get("botIdHash");
    if (kind === "authed" && (!userId || !Types.ObjectId.isValid(userId))) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid userId" }, { status: 400 }), actor);
    }
    if (kind === "anon" && (!botIdHash || typeof botIdHash !== "string" || botIdHash.trim().length < 16)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid botIdHash" }, { status: 400 }), actor);
    }

    const limit = Math.min(200, asPositiveInt(url.searchParams.get("limit")) ?? 50);

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
    if (!docExists) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    // Visit timelines are deep analytics (Pro). Checked after ownership so foreign docs stay 404.
    const gate = await checkLimit(actor.orgId, "analytics_history");
    if (!gate.ok) return applyTempUserHeaders(planLimitResponse(gate), actor);

    // Per-link scope. An unknown slug is a 404, like the metrics route — never a silent whole-doc read.
    const shareIdFilter = (url.searchParams.get("shareId") ?? "").trim();
    const link = shareIdFilter
      ? await ShareLinkModel.findOne({ shareId: shareIdFilter, docId: docObjectId }).lean<ShareLink>()
      : null;
    if (shareIdFilter && !link) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    // `docId` stays in the filter even under a link filter: `sharevisits.shareId` is only unique
    // together with (botIdHash, visitIdHash), so a slug is not by itself a tenancy boundary on
    // this collection — only `sharelinks.shareId` is globally unique, and nothing re-checks that
    // invariant on the analytics rows after a slug rotation, a restored backup or a doc clone.
    // `visits/[visitId]` already anchors on both; the route that returns a *list* must not be the
    // looser of the two.
    //
    // `RECIPIENT_ONLY_MATCH`: the owner's own sessions are recorded but never listed here, so this
    // timeline shows exactly the sessions the counts beside it are built from.
    //
    // A project link (docs/prds/lnkdrp-project-links.md) writes `ShareVisit` rows carrying the
    // `docId` of each document opened inside the data room, so the unfiltered branch has to drop
    // the slugs that are not this document's links — the same bound `/shareviews` applies, for the
    // same reason: those sessions belong to the project's timeline, not the document's.
    const foreignShareIds: string[] = link ? [] : await projectLinkSlugsForDocs([docObjectId], { source: "visits" });
    const query: Record<string, unknown> = {
      ...(link
        ? { docId: docObjectId, shareId: link.shareId }
        : { docId: docObjectId, ...shareIdClause({ except: foreignShareIds }) }),
      ...RECIPIENT_ONLY_MATCH,
    };
    if (kind === "authed") query.viewerUserId = new Types.ObjectId(userId!);
    if (kind === "anon") query.botIdHash = botIdHash!.trim();

    const visits = await ShareVisitModel.find(query)
      .sort({ lastEventAt: -1 })
      .limit(limit)
      .select({
        _id: 1,
        startedAt: 1,
        lastEventAt: 1,
        timeSpentMs: 1,
        pagesSeen: 1,
        pageTimeMsByPage: 1,
        pageVisitCountByPage: 1,
        // The last two segments are enough to say where the reader is: a `turn` records the page
        // they left and `toPage` the one they went to, so the newest event names the page they are
        // on now. Only the tail is read; the array itself is capped by the ingest.
        pageEvents: 1,
        pageCount: 1,
      })
      .lean();

    return applyTempUserHeaders(
      NextResponse.json(
        {
          ok: true,
          docId,
          /** The link these visits are scoped to, or null for "every link of the document". */
          shareId: link ? link.shareId : null,
          kind,
          visits: visits.map((v: any) => ({
            visitId: String(v._id),
            startedAt: v.startedAt ? new Date(v.startedAt).toISOString() : null,
            lastEventAt: v.lastEventAt ? new Date(v.lastEventAt).toISOString() : null,
            timeSpentMs: typeof v.timeSpentMs === "number" && Number.isFinite(v.timeSpentMs) ? Math.max(0, Math.floor(v.timeSpentMs)) : 0,
            pagesSeen: Array.isArray(v.pagesSeen) ? v.pagesSeen : [],
            pageTimeMsByPage: v.pageTimeMsByPage && typeof v.pageTimeMsByPage === "object" ? v.pageTimeMsByPage : {},
            pageVisitCountByPage: v.pageVisitCountByPage && typeof v.pageVisitCountByPage === "object" ? v.pageVisitCountByPage : {},
            /**
             * The page this session is on, as far as the ingest knows.
             *
             * Page time is only written when a reader *leaves* a page, and a `turn` segment carries
             * `toPage` — the page they went to. So the newest event names where they are now, and
             * the page they are still sitting on is knowable without any new write. Falls back to
             * the segment's own page for a flush that was not a turn (a tab hidden, a reload),
             * where the last page they were on is the best answer there is.
             *
             * And falls back once more to the furthest page seen, because a document with ONE page
             * never produces an event at all — there is nowhere to turn to — so the live half of
             * the reader page went dark for exactly the documents where it is easiest to be sure.
             * An exit is evidence and a page seen is an inference, which is why it is last.
             */
            currentPage: (() => {
              const events = Array.isArray(v.pageEvents) ? v.pageEvents : [];
              const last = events.length ? events[events.length - 1] : null;
              const to = Number(last?.toPage);
              if (Number.isFinite(to) && to >= 1) return Math.floor(to);
              const on = Number(last?.pageNumber);
              if (Number.isFinite(on) && on >= 1) return Math.floor(on);
              const seen = Array.isArray(v.pagesSeen) ? (v.pagesSeen as number[]).filter((n) => Number.isFinite(n) && n >= 1) : [];
              return seen.length ? Math.max(...seen) : null;
            })(),
            /** What the viewer reported the document's length to be, for "page 4 of 9". */
            pageCount: Number.isFinite(Number(v.pageCount)) && Number(v.pageCount) > 0 ? Math.floor(Number(v.pageCount)) : null,
          })),
        },
        { headers: { "cache-control": "no-store" } },
      ),
      actor,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return applyTempUserHeaders(NextResponse.json({ error: message }, { status: 400 }), actor);
  }
}

