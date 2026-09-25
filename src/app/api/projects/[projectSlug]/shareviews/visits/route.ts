/**
 * One person's sessions in a project.
 * Route: `/api/projects/:projectSlug/shareviews/visits`
 *
 * The document route's counterpart, and deliberately not the same shape underneath: a tab session
 * inside a data room spans documents. One `ShareVisit` row is written per (visit, document), so a
 * reader who opened the deck and then the term sheet in one sitting leaves two rows that are one
 * session. They are grouped back together here, by visit id, and each session says which documents
 * it touched and how long each held them.
 *
 * That grouping is the whole reason this route exists rather than the client calling the document
 * route per document: "they opened the deck first, then the term sheet, and never came back" is a
 * fact about the session, and it is unrecoverable once the rows are read one document at a time.
 *
 * Same gates as the rest of the project analytics: workspace membership, then the deep-analytics
 * tier, then recipients only — the owner's own sessions are recorded but never listed.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { applyTempUserHeaders } from "@/lib/gating/actor";
import { errorJson } from "@/lib/http/errorResponse";
import { botIdHashPrefixFilter } from "@/lib/projects/requestSettings";
import { connectMongo } from "@/lib/mongodb";
import { analyticsTierForPlan, getWorkspacePlan } from "@/lib/billing/planLimits";
import { DocModel } from "@/lib/models/Doc";
import { PROJECT_LINK_FILTER, ShareLinkModel, type ShareLink } from "@/lib/models/ShareLink";
import { ShareVisitModel } from "@/lib/models/ShareVisit";
import { accessProjectForLinks } from "../../links/shared";
import { projectShareIds } from "@/lib/share/projectLinks";
import { projectViewerKey } from "@/lib/share/projectPublic";
import { currentPageFromRow } from "@/lib/analytics/reading/currentPage";
import { RECIPIENT_ONLY_MATCH } from "@/lib/analytics/shareViewAggregates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One document's share of a session. */
type VisitDoc = { docId: string; title: string | null; timeSpentMs: number; pagesSeen: number[] };

export async function GET(request: Request, ctx: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await ctx.params;
  const gate = await accessProjectForLinks(request, projectSlug, "viewer");
  if (!gate.ok) return gate.response;
  const { actor, projectId, orgId } = gate.access;

  try {
    const url = new URL(request.url);
    const kindRaw = url.searchParams.get("kind");
    const kind = kindRaw === "authed" || kindRaw === "anon" ? kindRaw : null;
    const userIdRaw = (url.searchParams.get("userId") ?? "").trim();
    const botIdHashRaw = (url.searchParams.get("botIdHash") ?? "").trim();
    const shareIdFilter = (url.searchParams.get("shareId") ?? "").trim();
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));

    if (!kind) return applyTempUserHeaders(NextResponse.json({ error: "Missing kind" }, { status: 400 }), actor);
    if (kind === "authed" && !Types.ObjectId.isValid(userIdRaw)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid userId" }, { status: 400 }), actor);
    }
    if (kind === "anon" && !botIdHashRaw) {
      return applyTempUserHeaders(NextResponse.json({ error: "Missing botIdHash" }, { status: 400 }), actor);
    }
    // A hex digest or nothing: the old code stripped non-hex characters and built the prefix regex
    // from what was left, so a value like "not-a-hash" matched every anonymous visit in the room.
    const anonScope = kind === "anon" ? botIdHashPrefixFilter(botIdHashRaw) : null;
    if (kind === "anon" && !anonScope) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid botIdHash" }, { status: 400 }), actor);
    }

    await connectMongo();

    const plan = await getWorkspacePlan(String(orgId));
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

    /**
     * An anonymous reader's rows are keyed per document (`<digest>.<docId>`), so a prefix is the
     * only way to reach the whole person; a signed-in one is keyed by user id and needs no such
     * trick. The prefix is anchored and the digest is hex, so it cannot match a different reader.
     */
    const viewerScope = kind === "authed" ? { viewerUserId: new Types.ObjectId(userIdRaw) } : (anonScope ?? {});

    const rows = (await ShareVisitModel.find({ ...shareScope, ...viewerScope, ...RECIPIENT_ONLY_MATCH })
      .sort({ lastEventAt: -1 })
      // A session can hold one row per document, so the row budget is larger than the session one.
      .limit(limit * 10)
      // `pageEvents` and `pageCount` say where the reader is *now*: a `turn` segment records the
      // page they went to, so the newest event across a session's rows names both the document
      // they are in and the page they are on.
      .select({ _id: 1, visitIdHash: 1, docId: 1, startedAt: 1, lastEventAt: 1, timeSpentMs: 1, pagesSeen: 1, pageEvents: 1, pageCount: 1 })
      .lean()) as Array<Record<string, unknown>>;

    // Titles for everything touched, in one read rather than one per row.
    const docIds = [...new Set(rows.map((r) => String(r.docId ?? "")).filter(Boolean))];
    const docs = docIds.length
      ? ((await DocModel.find({ _id: { $in: docIds.map((id) => new Types.ObjectId(id)) }, orgId })
          .select({ title: 1 })
          .lean()) as Array<{ _id: Types.ObjectId; title?: string }>)
      : [];
    const titleById = new Map(docs.map((d) => [String(d._id), d.title ?? null]));

    type Session = {
      visitId: string;
      startedAt: string | null;
      lastEventAt: string | null;
      timeSpentMs: number;
      docs: VisitDoc[];
      /** The document they are in right now, and the page of it — newest page event wins. */
      currentDocId: string | null;
      currentDocTitle: string | null;
      currentPage: number | null;
      currentPageCount: number | null;
      /** Sort key for the above: the timestamp of the event it came from. */
      currentAt: string | null;
    };
    const sessions = new Map<string, Session>();
    for (const r of rows) {
      // `visitIdHash` is the tab session; rows without one are their own session rather than being
      // folded into a neighbour's.
      const key = String(r.visitIdHash ?? r._id);
      const startedAt = r.startedAt instanceof Date ? r.startedAt.toISOString() : null;
      const lastEventAt = r.lastEventAt instanceof Date ? r.lastEventAt.toISOString() : null;
      const timeSpentMs = typeof r.timeSpentMs === "number" && Number.isFinite(r.timeSpentMs) ? Math.max(0, Math.floor(r.timeSpentMs)) : 0;
      const docId = String(r.docId ?? "");
      const entry = sessions.get(key) ?? {
        visitId: key,
        startedAt,
        lastEventAt,
        timeSpentMs: 0,
        docs: [],
        currentDocId: null,
        currentDocTitle: null,
        currentPage: null,
        currentPageCount: null,
        currentAt: null,
      };
      // The session spans its rows: earliest start, latest event, summed time.
      if (startedAt && (!entry.startedAt || startedAt < entry.startedAt)) entry.startedAt = startedAt;
      if (lastEventAt && (!entry.lastEventAt || lastEventAt > entry.lastEventAt)) entry.lastEventAt = lastEventAt;
      entry.timeSpentMs += timeSpentMs;
      /**
       * Where this row leaves the reader, and whether it is the freshest thing in the session.
       *
       * A project session spans documents, so "the page they are on" is only meaningful together
       * with the document it belongs to — page 3 of the deck is not page 3 of the term sheet.
       *
       * Two questions, and they are not answered by the same field. *Which document* is the one
       * with the most recent activity, which is `lastEventAt`: every stats post moves it, starting
       * with the one the viewer sends the moment a document is opened. *Which page of it* is
       * `currentPageFromRow`, which reads the newest page event and falls back from there — the
       * same rule the document scope uses, which is why it lives in a module and not here.
       *
       * Asking the event both questions is what made switching documents lag. A reader moving back
       * to a file they had already read brought an event stamped when they last *left* it, so the
       * room's freshest event still belonged to the document they had just walked away from, and
       * "the document they are in" stayed wrong until they turned a page in the new one — up to a
       * whole heartbeat, and for ever on a document with one page.
       */
      const page = currentPageFromRow(r);
      const at = lastEventAt;
      if (page && at && docId) {
        // Strictly newer. The rows arrive sorted newest-first, so a tie must leave the sort's
        // answer standing rather than let an older row overwrite it.
        if (!entry.currentAt || at > entry.currentAt) {
          entry.currentAt = at;
          entry.currentDocId = docId;
          entry.currentDocTitle = titleById.get(docId) ?? null;
          entry.currentPage = page;
          const count = Number(r.pageCount);
          entry.currentPageCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : null;
        }
      }
      if (docId) {
        entry.docs.push({
          docId,
          title: titleById.get(docId) ?? null,
          timeSpentMs,
          pagesSeen: Array.isArray(r.pagesSeen) ? (r.pagesSeen as number[]) : [],
        });
      }
      sessions.set(key, entry);
    }

    const list = [...sessions.values()]
      .map((s) => ({ ...s, docs: s.docs.sort((a, b) => b.timeSpentMs - a.timeSpentMs) }))
      .sort((a, b) => (b.lastEventAt ?? "").localeCompare(a.lastEventAt ?? ""))
      .slice(0, limit);

    return applyTempUserHeaders(
      NextResponse.json({ ok: true, kind, visits: list }, { headers: { "cache-control": "no-store" } }),
      actor,
    );
  } catch (err) {
    return applyTempUserHeaders(
      errorJson(err, { status: 500, publicMessage: "Could not load visits", context: "[api/projects/:slug/shareviews/visits] GET failed" }),
      actor,
    );
  }
}
