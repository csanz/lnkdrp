/**
 * API route for `/api/uploads/in-progress`.
 *
 * The uploads this workspace has in flight right now, with how far each one has got. The Activity
 * feed calls it once on mount and then lives off `upload` realtime frames: without it a page
 * opened halfway through a long import shows nothing at all until the next frame happens to land,
 * which on the summarize stage can be half a minute of blank.
 *
 * Deliberately two sources, unioned. `Upload.orgId` is the fast path and is what new rows carry,
 * but it is a recent field — rows that predate it, or that were created by a path which never set
 * it, would be invisible. The document's own `preparing` status is the older, unambiguous fact
 * ("this document is mid-upload"), so it backfills the list.
 *
 * Read-only. Viewers and above; temp users get an empty list rather than a 401, like `/api/activity`.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { debugLog } from "@/lib/debug";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { DocModel } from "@/lib/models/Doc";
import { UploadModel } from "@/lib/models/Upload";
import { requireOrgRole } from "@/lib/orgs/requireOrgRole";
import { lockedHomeExclusionFor } from "@/lib/projects/lockScope";
import { IN_FLIGHT_UPLOAD_STATUSES } from "@/lib/uploads/progress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Most in-flight uploads to return; a workspace with more than this has other problems. */
const MAX_ITEMS = 25;
/**
 * How far back to look. A run that claimed `processing` and then died is re-claimable after 20
 * minutes (`PROCESSING_STALE_MS` in the process route); anything older than half an hour is not
 * in flight, it is abandoned, and showing it as a live bar would be a lie.
 */
const MAX_AGE_MS = 30 * 60 * 1000;

export async function GET(request: Request) {
  try {
    const actor = await resolveActor(request);
    if (actor.kind !== "user") {
      return applyTempUserHeaders(
        NextResponse.json({ items: [] }, { headers: { "cache-control": "no-store" } }),
        actor,
      );
    }
    const roleCheck = await requireOrgRole({ orgId: actor.orgId, userId: actor.userId, minRole: "viewer" });
    if (!roleCheck.ok) {
      return NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status });
    }

    await connectMongo();
    const orgId = new Types.ObjectId(actor.orgId);
    const since = new Date(Date.now() - MAX_AGE_MS);

    /**
     * Documents this workspace believes are mid-upload, for the union below and for their titles.
     *
     * Both document reads carry the locked-room exclusion (decision 11), and the `filter` at the end of
     * this handler is what makes that enough: a row whose document could not be resolved has no title
     * and is dropped, so an upload into a private room simply is not in this feed for a non-member.
     */
    const lockedExclusion = await lockedHomeExclusionFor(orgId, actor.userId, request);
    const preparingDocs = await DocModel.find({ orgId, status: "preparing", isDeleted: { $ne: true }, ...lockedExclusion })
      .select({ _id: 1, title: 1 })
      .sort({ updatedDate: -1 })
      .limit(MAX_ITEMS * 2)
      .lean();
    const titles = new Map<string, string | null>();
    for (const d of preparingDocs) {
      titles.set(String(d._id), typeof d.title === "string" ? d.title : null);
    }
    const preparingDocIds = preparingDocs.map((d) => d._id as Types.ObjectId);

    const rows = await UploadModel.find({
      isDeleted: { $ne: true },
      status: { $in: [...IN_FLIGHT_UPLOAD_STATUSES] },
      updatedDate: { $gte: since },
      ...(preparingDocIds.length ? { $or: [{ orgId }, { docId: { $in: preparingDocIds } }] } : { orgId }),
    })
      .select({ _id: 1, docId: 1, version: 1, status: 1, progress: 1, updatedDate: 1 })
      .sort({ updatedDate: -1 })
      .limit(MAX_ITEMS)
      .lean();

    // Titles for uploads that came in on the `orgId` branch (their document is not `preparing`,
    // e.g. a replacement whose document still points at the last good version).
    const missing = rows
      .map((r) => (r.docId ? String(r.docId) : ""))
      .filter((id) => id && !titles.has(id))
      .map((id) => new Types.ObjectId(id));
    if (missing.length) {
      const extra = await DocModel.find({ _id: { $in: missing }, orgId, ...lockedExclusion })
        .select({ _id: 1, title: 1 })
        .lean();
      for (const d of extra) titles.set(String(d._id), typeof d.title === "string" ? d.title : null);
    }

    const items = rows
      // The `docId: $in` branch can only match this workspace's documents, and the `orgId` branch
      // only this workspace's uploads — but a row whose document we could not resolve at all is
      // one we cannot name or link, so it is not worth a line in the feed.
      .filter((r) => r.docId && titles.has(String(r.docId)))
      .map((r) => {
        const progress = (r as { progress?: { percent?: unknown; stage?: unknown } }).progress;
        const percent = Number(progress?.percent);
        const docId = String(r.docId);
        return {
          id: String(r._id),
          docId,
          docTitle: titles.get(docId) ?? null,
          percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : 0,
          stage: typeof progress?.stage === "string" && progress.stage ? progress.stage : "preparing",
          status: typeof r.status === "string" ? r.status : "processing",
          version: Number.isFinite(r.version) ? Number(r.version) : null,
          updatedAt: r.updatedDate ? new Date(r.updatedDate as Date).toISOString() : null,
          finishedAt: null,
        };
      });

    debugLog(2, "[api/uploads/in-progress] GET", { count: items.length });
    return applyTempUserHeaders(
      NextResponse.json({ items }, { headers: { "cache-control": "no-store" } }),
      actor,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
