/**
 * API route for `/api/tags/targets` — the tags on many things at once.
 *
 * The sidebar prints a dot per tag on every project row, and one request per row would be dozens.
 * `GET ?targetKind=project&ids=a,b,c` answers for the whole list in one read. Any kind in
 * `TAG_TARGET_KINDS` works the same way (`contact` is how the Contacts table prints its Tags column).
 *
 * Ids are the caller's own workspace's or they simply do not appear: the assignment rows are
 * scoped by `orgId`, so an id from elsewhere returns nothing rather than an error, which is the
 * right shape for a list that may contain a row the sidebar cached before it was deleted.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { DocModel } from "@/lib/models/Doc";
import { hiddenProjectIds, lockedHomeExclusion } from "@/lib/projects/lockScope";
import { TAG_TARGET_KINDS, type TagTargetKind } from "@/lib/models/TagAssignment";
import { tagsForTargets } from "@/lib/tags/service";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Enough for any sidebar; a longer list is a sign the caller should be paging, not tagging. */
const MAX_IDS = 200;

export async function GET(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActor(request);
    if (actor.kind !== "user") {
      return applyTempUserHeaders(NextResponse.json({ error: "Unauthorized" }, { status: 401 }), actor);
    }

    const url = new URL(request.url);
    const kindRaw = url.searchParams.get("targetKind") ?? "";
    const targetKind = (TAG_TARGET_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as TagTargetKind) : null;
    // Junk in the list is skipped, not fatal. `tagsForTargets` hands every id straight to
    // `new Types.ObjectId(...)`, which throws on anything that is not an id, so a single bad entry
    // used to take the whole request down with a 500 and a stack trace and lose the dots for the
    // valid ids beside it; `useTargetTags` swallows the failed response, so the rows just went bare
    // with nothing to retry. The header above promises the opposite, and /api/docs already filters
    // the same comma-separated shape this way, so the check belongs here at the boundary. It runs
    // before the cap so junk cannot spend the 200 slots a real sidebar needs.
    const ids = (url.searchParams.get("ids") ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter((v) => Types.ObjectId.isValid(v))
      .slice(0, MAX_IDS);

    if (!targetKind) {
      return applyTempUserHeaders(NextResponse.json({ error: "targetKind is required" }, { status: 400 }), actor);
    }
    if (!ids.length) {
      return applyTempUserHeaders(NextResponse.json({ ok: true, tags: {} }, { headers: { "cache-control": "no-store" } }), actor);
    }

    /**
     * Ids the caller may not see never reach the assignment read
     * (docs/prds/lnkdrp-locked-projects.md, decision 16).
     *
     * A dot on a row is small and this endpoint is not: it takes two hundred arbitrary ids and says,
     * per id, whether the workspace has anything filed about it. Handed a locked room's id it answered
     * that room's tags, which both confirms the room exists and names what it is about. The room half
     * costs nothing — `hiddenProjectIds` is the answer already — and the document half pays one indexed
     * `_id` read, and only while the workspace actually holds a locked room, so the sidebar's hot path
     * is untouched in every workspace that has never locked anything.
     */
    // `connectMongo` here and not in the service: this is the first read this handler makes now, and
    // `hiddenProjectIds` refuses rather than guessing when it cannot see the collection.
    await connectMongo();
    const hidden = await hiddenProjectIds(actor.orgId, actor.userId, request);
    let visibleIds = ids;
    if (hidden.length) {
      if (targetKind === "project") {
        const hiddenSet = new Set(hidden.map((id) => String(id)));
        visibleIds = ids.filter((id) => !hiddenSet.has(id));
      } else if (targetKind === "doc") {
        const rows = (await DocModel.find({
          _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
          orgId: new Types.ObjectId(actor.orgId),
          ...lockedHomeExclusion(hidden),
        })
          .select({ _id: 1 })
          .lean()) as Array<{ _id: Types.ObjectId }>;
        const live = new Set(rows.map((r) => String(r._id)));
        visibleIds = ids.filter((id) => live.has(id));
      }
    }
    if (!visibleIds.length) {
      return applyTempUserHeaders(NextResponse.json({ ok: true, tags: {} }, { headers: { "cache-control": "no-store" } }), actor);
    }

    const byTarget = await tagsForTargets({ orgId: actor.orgId, targetKind, targetIds: visibleIds });
    const tags: Record<string, unknown[]> = {};
    for (const [targetId, list] of byTarget) tags[targetId] = list;

    return applyTempUserHeaders(
      NextResponse.json({ ok: true, tags }, { headers: { "cache-control": "no-store" } }),
      actor,
    );
  });
}
