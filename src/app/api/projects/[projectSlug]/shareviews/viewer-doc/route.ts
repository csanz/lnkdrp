/**
 * One person's reading of **one document inside a data room**.
 * Route: `/api/projects/:projectSlug/shareviews/viewer-doc`
 *
 * The project drawer answers "Steve opened 1 document in 5m 53s" and then stops, which is exactly
 * where a sender's next question begins: *which pages, and for how long*. On a document link that
 * question is already answered — the drawer draws a per-page chart from the `ShareView` row — and
 * the same fact exists here, because a project link writes **one row per (viewer, document)**
 * (`projectViewerKey`, docs/METRICS.md). The room's viewer aggregate deliberately drops the
 * per-page fields when it merges those rows together, since "pages viewed" is not a fact about a
 * project. This route goes back for the single row that was merged.
 *
 * So it is a drill-down, not a second source of truth: same collection, same window, same
 * owner-preview exclusion, same Pro gate as the drawer it opens from. The response is shaped like
 * the per-viewer half of the document route's payload so `MetricsView` can render it with the
 * components it already uses for a document.
 *
 * Scope: `?shareId=` narrows to one of the project's links, exactly as on the parent route; without
 * it, every slug the project has ever owned counts, which is what the drawer behind it did.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { applyTempUserHeaders } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";
import { analyticsTierForPlan, clampAnalyticsDays, getWorkspacePlan } from "@/lib/billing/planLimits";
import { DocModel } from "@/lib/models/Doc";
import { PROJECT_LINK_FILTER, ShareLinkModel, type ShareLink } from "@/lib/models/ShareLink";
import { ShareViewModel } from "@/lib/models/ShareView";
import { ShareVisitModel } from "@/lib/models/ShareVisit";
import { accessProjectForLinks } from "../../links/shared";
import { projectShareIds } from "@/lib/share/projectLinks";
import { projectViewerKey } from "@/lib/share/projectPublic";
import { RECIPIENT_ONLY_MATCH, activityWindowMatch, windowStartUtc } from "@/lib/analytics/shareViewAggregates";
import { errorJson } from "@/lib/http/errorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function asPositiveInt(v: string | null): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** Page numbers, de-duplicated and ordered, from whatever the row happens to hold. */
function normalizePages(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const pages = new Set<number>();
  for (const p of raw) {
    const n = Number(p);
    if (Number.isFinite(n) && n > 0) pages.add(Math.floor(n));
  }
  return [...pages].sort((a, b) => a - b);
}

/** `{ "3": 12000 }` — dropping anything that is not a positive page with a real duration. */
function normalizePageTimes(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const page = Number(k);
    const ms = Number(v);
    if (!Number.isFinite(page) || page <= 0) continue;
    if (!Number.isFinite(ms) || ms <= 0) continue;
    out[String(Math.floor(page))] = Math.floor(ms);
  }
  return out;
}

export async function GET(request: Request, ctx: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await ctx.params;
  const gate = await accessProjectForLinks(request, projectSlug, "viewer");
  if (!gate.ok) return gate.response;
  const { actor, projectId, orgId } = gate.access;
  try {
    const url = new URL(request.url);
    const docIdRaw = (url.searchParams.get("docId") ?? "").trim();
    const userIdRaw = (url.searchParams.get("userId") ?? "").trim();
    const botIdHashRaw = (url.searchParams.get("botIdHash") ?? "").trim();
    const shareIdFilter = (url.searchParams.get("shareId") ?? "").trim();
    const requestedDays = Math.min(365, asPositiveInt(url.searchParams.get("days")) ?? 15);

    if (!Types.ObjectId.isValid(docIdRaw)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid docId" }, { status: 400 }), actor);
    }
    // Exactly one viewer, named one way or the other — the same two shapes the drawer holds.
    if (Boolean(userIdRaw) === Boolean(botIdHashRaw)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Name one viewer" }, { status: 400 }), actor);
    }
    if (userIdRaw && !Types.ObjectId.isValid(userIdRaw)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid userId" }, { status: 400 }), actor);
    }

    await connectMongo();

    const plan = await getWorkspacePlan(String(orgId));
    const days = clampAnalyticsDays(plan, requestedDays);
    // Who a reader is, and what they read, is deep analytics — the same gate the drawer itself
    // passes before it can show a name to click on.
    if (analyticsTierForPlan(plan) !== "deep") {
      return applyTempUserHeaders(NextResponse.json({ error: "UPGRADE_REQUIRED" }, { status: 402 }), actor);
    }

    const { all: allShareIds } = await projectShareIds({ orgId, projectId });
    const link = shareIdFilter
      ? await ShareLinkModel.findOne({ shareId: shareIdFilter, projectId, ...PROJECT_LINK_FILTER }).lean<ShareLink>()
      : null;
    if (shareIdFilter && !link) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }
    const shareScope = link ? { shareId: link.shareId } : { shareId: { $in: allShareIds } };

    const docObjectId = new Types.ObjectId(docIdRaw);
    const start = windowStartUtc(days);
    /**
     * The viewer, in the shape the rows are actually keyed on.
     *
     * A signed-in reader is found by `viewerUserId`. An anonymous one is found by the composite
     * `<digest>.<docId>` this document's row was written under — built rather than matched with a
     * prefix, because we know precisely which document is being asked about.
     */
    const viewerMatch = userIdRaw
      ? { viewerUserId: new Types.ObjectId(userIdRaw) }
      : { botIdHash: projectViewerKey(botIdHashRaw, docIdRaw) };

    const match = { ...shareScope, docId: docObjectId, ...viewerMatch, ...RECIPIENT_ONLY_MATCH };

    const [rows, doc, sessionRows] = await Promise.all([
      ShareViewModel.find({ ...match, ...activityWindowMatch(start) })
        .select({
          shareId: 1,
          pagesSeen: 1,
          pagesViewed: 1,
          pageTimeMsByPage: 1,
          timeSpentMs: 1,
          viewerName: 1,
          viewerEmailSnapshot: 1,
          createdDate: 1,
          lastViewedAt: 1,
          updatedDate: 1,
        })
        .lean(),
      /**
       * Scoped to the caller's workspace, not looked up by id alone.
       *
       * `docId` is a query parameter. Unscoped, this answered with any document's title for any
       * ObjectId in the database — and the `deleted: !doc` flag turned it into an existence oracle
       * — for anyone holding viewer access to any project in any Pro workspace. Every sibling
       * surface scopes its document reads (`buildDocMatch`, `findProjectDocument`, `docScopeMatch`);
       * this one now does too.
       */
      DocModel.findOne({ _id: docObjectId, orgId }).select({ title: 1, isDeleted: 1 }).lean(),
      // Sessions: distinct tab visits on this document. One tab reading two files in the room
      // shares a `visitIdHash` across both rows, so counting rows would double a reader's sessions.
      ShareVisitModel.distinct("visitIdHash", {
        ...shareScope,
        docId: docObjectId,
        ...(userIdRaw ? { viewerUserId: new Types.ObjectId(userIdRaw) } : { botIdHash: projectViewerKey(botIdHashRaw, docIdRaw) }),
        ...RECIPIENT_ONLY_MATCH,
        lastEventAt: { $gte: start },
      }),
    ]);

    if (!rows.length) {
      // Nothing in this window. Not a 404: the viewer and the document both exist, the reading is
      // simply outside the range the page is showing, and the drawer should say so.
      return applyTempUserHeaders(
        NextResponse.json(
          {
            ok: true,
            docId: docIdRaw,
            title: (doc as { title?: string } | null)?.title ?? null,
            deleted: Boolean((doc as { isDeleted?: boolean } | null)?.isDeleted) || !doc,
            days,
            views: 0,
            pagesViewed: 0,
            pagesSeen: [],
            pageTimeMsByPage: {},
            timeSpentMs: 0,
            sessions: 0,
            firstSeen: null,
            lastSeen: null,
          },
          { headers: { "cache-control": "no-store" } },
        ),
        actor,
      );
    }

    /**
     * Normally one row. It can be more than one: a project's links each write their own, so an
     * unfiltered read covers a reader who came through two of them, and the two must be summed
     * rather than picked between — the drawer behind this one already summed them.
     */
    type Row = {
      pagesSeen?: unknown;
      pagesViewed?: unknown;
      pageTimeMsByPage?: unknown;
      timeSpentMs?: unknown;
      createdDate?: Date | null;
      lastViewedAt?: Date | null;
      updatedDate?: Date | null;
    };
    const pages = new Set<number>();
    const pageTimeMsByPage: Record<string, number> = {};
    let timeSpentMs = 0;
    let firstSeen: Date | null = null;
    let lastSeen: Date | null = null;
    for (const r of rows as Row[]) {
      for (const p of normalizePages(r.pagesSeen)) pages.add(p);
      for (const [page, ms] of Object.entries(normalizePageTimes(r.pageTimeMsByPage))) {
        pageTimeMsByPage[page] = (pageTimeMsByPage[page] ?? 0) + ms;
      }
      const t = Number(r.timeSpentMs);
      if (Number.isFinite(t) && t > 0) timeSpentMs += Math.floor(t);
      const first = r.createdDate instanceof Date ? r.createdDate : null;
      const last = r.lastViewedAt instanceof Date ? r.lastViewedAt : r.updatedDate instanceof Date ? r.updatedDate : null;
      if (first && (!firstSeen || first < firstSeen)) firstSeen = first;
      if (last && (!lastSeen || last > lastSeen)) lastSeen = last;
    }
    const pagesSeen = [...pages].sort((a, b) => a - b);

    return applyTempUserHeaders(
      NextResponse.json(
        {
          ok: true,
          docId: docIdRaw,
          title: (doc as { title?: string } | null)?.title ?? null,
          // A document removed from the project keeps the reading it earned inside it.
          deleted: Boolean((doc as { isDeleted?: boolean } | null)?.isDeleted) || !doc,
          days,
          views: rows.length,
          pagesViewed: pagesSeen.length,
          pagesSeen,
          pageTimeMsByPage,
          timeSpentMs,
          sessions: Array.isArray(sessionRows) ? sessionRows.filter(Boolean).length : 0,
          firstSeen: firstSeen ? firstSeen.toISOString() : null,
          lastSeen: lastSeen ? lastSeen.toISOString() : null,
        },
        { headers: { "cache-control": "no-store" } },
      ),
      actor,
    );
  } catch (err) {
    return errorJson(err, {
      status: 500,
      publicMessage: "Could not load this reading",
      context: "[api/projects/:projectSlug/shareviews/viewer-doc] GET failed",
    });
  }
}
