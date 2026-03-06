/**
 * API route for `/api/docs/:docId/changes`.
 *
 * Returns replacement history (what changed) for a doc. Only available to users
 * who have access to the doc (same access rules as other `/api/docs/:docId/*` routes).
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { DocChangeModel } from "@/lib/models/DocChange";
import { UploadModel } from "@/lib/models/Upload";
import { UserModel } from "@/lib/models/User";
import { applyTempUserHeaders, resolveActor, tryResolveUserActorFastWithPersonalOrg } from "@/lib/gating/actor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isObjectId(id: string) {
  return Types.ObjectId.isValid(id);
}

export async function GET(request: Request, ctx: { params: Promise<{ docId: string }> }) {
  try {
    const url = new URL(request.url);
    const lite = url.searchParams.get("lite") === "1";
    const noText = url.searchParams.get("noText") === "1";
    const wantsDebug = url.searchParams.get("debug") === "1";
    const sortParam = (url.searchParams.get("sort") ?? "").trim().toLowerCase();
    const sort: "version_desc" | "version_asc" = sortParam === "version_asc" ? "version_asc" : "version_desc";
    const cursorParam = (url.searchParams.get("cursor") ?? "").trim();
    const cursorVersion = cursorParam ? Number(cursorParam) : NaN;
    const limitParam = url.searchParams.get("limit");
    // NOTE: `URLSearchParams.get()` returns `null` when missing. `Number(null) === 0`,
    // so we must treat null/empty as "unset" (default = 50).
    const parsedLimit = typeof limitParam === "string" && limitParam.trim() ? Number(limitParam) : NaN;
    const limit = Math.max(1, Math.min(50, Number.isFinite(parsedLimit) ? parsedLimit : 50));

    const { docId } = await ctx.params;
    if (!isObjectId(docId)) return NextResponse.json({ error: "Invalid docId" }, { status: 400 });

    const actor = (await tryResolveUserActorFastWithPersonalOrg(request)) ?? (await resolveActor(request));
    await connectMongo();

    // Authorization: doc must belong to the actor's org (with legacy personal-org fallback).
    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
    const docObjectId = new Types.ObjectId(docId);
    const doc = await DocModel.findOne({
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
    })
      .select({ _id: 1, orgId: 1, title: 1, currentUploadVersion: 1 })
      .lean();
    if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Modes:
    // - lite=1: used by doc page replace banner; cheapest possible (no joins, no change list).
    // - noText=1: used by history page; includes change list but omits large text blobs.
    // - default: full payload (includes text blobs, createdBy, etc).
    const includeChangeList = !lite;
    const includeText = !lite && !noText;

    /**
     * Best-effort backfill: ensure we have at least a "replacement event" row for each upload version.
     *
     * Why: older uploads (or rare extraction failures) can have missing text snapshots; in that case
     * the upload processor may skip creating a DocChange record. The History UI should still be able
     * to show that versions exist, even if we can't show a diff summary.
     *
     * Boundaries:
     * - Only backfill recent versions (bounded by `limit`) for perf.
     * - Never overwrite an existing DocChange record (only insert missing).
     * - Never generate AI diffs here (no credits / no network calls).
     */
    const debug = wantsDebug && process.env.NODE_ENV !== "production";
    const debugInfo: Record<string, unknown> | null = debug ? {} : null;
    if (includeChangeList) {
      try {
        const insertedVersions: number[] = [];
        const uploads = (await UploadModel.find({
          docId: docObjectId,
          isDeleted: { $ne: true },
          status: "completed",
          version: { $gte: 1 },
        })
          .select({ _id: 1, version: 1, createdDate: 1, userId: 1 })
          .sort({ version: -1, createdDate: -1 })
          .limit(limit + 1)
          .lean()) as Array<Record<string, any>>;

        const byVersion = new Map<number, Record<string, any>>();
        for (const u of uploads) {
          const v = typeof u?.version === "number" && Number.isFinite(u.version) ? Number(u.version) : null;
          if (!v || v < 1) continue;
          // Keep first-seen entry (highest version, then newest createdDate due to sort).
          if (!byVersion.has(v)) byVersion.set(v, u);
        }

        if (debugInfo) {
          debugInfo.uploads = {
            limit,
            found: uploads.length,
            versions: Array.from(byVersion.keys()).sort((a, b) => a - b),
            sample: uploads.slice(0, 8).map((u) => ({
              id: u?._id ? String(u._id) : null,
              version: typeof u?.version === "number" ? u.version : null,
              status: typeof u?.status === "string" ? u.status : null,
              isDeleted: Boolean(u?.isDeleted),
              createdDate: u?.createdDate instanceof Date ? u.createdDate.toISOString() : null,
              userId: u?.userId ? String(u.userId) : null,
              orgId: u?.orgId ? String(u.orgId) : null,
            })),
          };
          debugInfo.actor = { orgId: actor.orgId, personalOrgId: actor.personalOrgId, allowLegacyByUserId };
          debugInfo.doc = {
            id: docId,
            orgId: (doc as any)?.orgId ? String((doc as any).orgId) : null,
            title: typeof (doc as any)?.title === "string" ? String((doc as any).title) : null,
            currentUploadVersion: (doc as any)?.currentUploadVersion ?? null,
          };
        }

        const backfillOrgId =
          (doc as any)?.orgId && Types.ObjectId.isValid(String((doc as any).orgId))
            ? new Types.ObjectId(String((doc as any).orgId))
            : new Types.ObjectId(actor.orgId);

        for (const [v, u] of byVersion.entries()) {
          if (v < 2) continue;
          const prev = byVersion.get(v - 1) ?? null;
          const createdDate = u?.createdDate instanceof Date ? u.createdDate : null;
          const createdByUserIdRaw = u?.userId ? String(u.userId) : "";
          const createdByUserId =
            createdByUserIdRaw && Types.ObjectId.isValid(createdByUserIdRaw)
              ? new Types.ObjectId(createdByUserIdRaw)
              : null;

          const res = await DocChangeModel.updateOne(
            { docId: docObjectId, toVersion: v },
            {
              $setOnInsert: {
                orgId: backfillOrgId,
                docId: docObjectId,
                createdByUserId,
                fromUploadId: prev?._id ?? null,
                toUploadId: u?._id ?? null,
                fromVersion: v - 1,
                toVersion: v,
                previousText: "",
                newText: "",
                diff: { summary: "", changes: [], pagesThatChanged: [] },
                // Preserve original timing when possible; fallback is "now".
                createdDate: createdDate ?? new Date(),
                updatedDate: createdDate ?? new Date(),
              },
            },
            // Avoid Mongoose timestamps overriding our backfilled createdDate.
            { upsert: true, timestamps: false },
          );
          const upsertedId =
            res && typeof res === "object" && "upsertedId" in (res as any) ? (res as any).upsertedId : null;
          if (upsertedId) insertedVersions.push(v);
        }

        if (debugInfo) {
          debugInfo.backfill = {
            attempted: true,
            insertedVersions: insertedVersions.sort((a, b) => a - b),
          };
        }
      } catch {
        // ignore; best-effort
        if (debugInfo) debugInfo.backfill = { attempted: true, error: "backfill_failed" };
      }
    }

    // Important: do NOT org-scope DocChange reads.
    //
    // Rationale: doc access is already validated above (org-scoped with legacy fallback),
    // and `docId` is globally unique. Older DocChange rows can have:
    // - missing orgId (legacy), or
    // - a stale orgId from before backfills/org switching
    // which would incorrectly hide history entries. Reading by docId avoids that.
    const changeFilter: Record<string, unknown> = { docId: docObjectId };
    const changeSelect: Record<string, 1> = {
      _id: 1,
      docId: 1,
      fromUploadId: 1,
      toUploadId: 1,
      fromVersion: 1,
      toVersion: 1,
      diff: 1,
      createdDate: 1,
      createdByUserId: 1,
      ...(includeText ? { previousText: 1, newText: 1 } : {}),
    } as const;

    if (Number.isFinite(cursorVersion) && cursorVersion >= 1) {
      // Cursor is always the `toVersion` boundary (fast + stable).
      (changeFilter as any).toVersion =
        sort === "version_asc" ? { $gt: Math.floor(cursorVersion) } : { $lt: Math.floor(cursorVersion) };
    }

    // Query optimization: `toVersion` is unique per doc; sorting by `{ toVersion }` is sufficient.
    // Avoid secondary sorts (e.g. createdDate) so Mongo can use the `(docId, toVersion)` index.
    const queryLimit = limit + 1; // fetch one extra to compute `nextCursor`
    const sortSpec = sort === "version_asc" ? { toVersion: 1 as const } : { toVersion: -1 as const };

    const changesAggRaw = (await DocChangeModel.find(changeFilter)
      .select(changeSelect)
      .sort(sortSpec)
      .limit(queryLimit)
      .lean()) as Array<Record<string, any>>;

    const hasMore = changesAggRaw.length > limit;
    const changesAgg = hasMore ? changesAggRaw.slice(0, limit) : changesAggRaw;
    const nextCursor = hasMore
      ? (function () {
          const last = changesAgg[changesAgg.length - 1];
          const v = typeof last?.toVersion === "number" && Number.isFinite(last.toVersion) ? Math.floor(last.toVersion) : null;
          return v && v >= 1 ? String(v) : null;
        })()
      : null;

    // Resolve createdBy in one query (faster than $lookup for large-ish result sets).
    const createdByMap: Map<string, { id: string; name: string | null; email: string | null }> = new Map();
    if (!lite) {
      const ids = Array.from(
        new Set(
          changesAgg
            .map((c) => (c?.createdByUserId ? String(c.createdByUserId) : ""))
            .filter((id) => id && Types.ObjectId.isValid(id)),
        ),
      );
      if (ids.length) {
        const users = await UserModel.find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) }, isActive: { $ne: false } })
          .select({ _id: 1, name: 1, email: 1 })
          .lean();
        for (const u of users) {
          const id = u?._id ? String(u._id) : "";
          if (!id) continue;
          const name = typeof (u as any).name === "string" && (u as any).name.trim() ? (u as any).name.trim() : null;
          const email = typeof (u as any).email === "string" && (u as any).email.trim() ? (u as any).email.trim() : null;
          createdByMap.set(id, { id, name, email });
        }
      }
    }

    return applyTempUserHeaders(
      NextResponse.json(
        {
          docId,
          ...(noText
            ? {
                docTitle: typeof (doc as any)?.title === "string" ? String((doc as any).title).trim() : "",
                currentUploadVersion:
                  typeof (doc as any)?.currentUploadVersion === "number" && Number.isFinite((doc as any).currentUploadVersion)
                    ? (doc as any).currentUploadVersion
                    : null,
              }
            : {}),
          changes: changesAgg.map((c) => ({
            id: String(c._id),
            docId: c.docId ? String(c.docId) : docId,
            fromUploadId: c.fromUploadId ? String(c.fromUploadId) : null,
            toUploadId: c.toUploadId ? String(c.toUploadId) : null,
            fromVersion: typeof c.fromVersion === "number" && Number.isFinite(c.fromVersion) ? c.fromVersion : null,
            toVersion: typeof c.toVersion === "number" && Number.isFinite(c.toVersion) ? c.toVersion : null,
            summary: c?.diff?.summary ?? "",
            ...(includeChangeList
              ? {
                  changes: Array.isArray(c?.diff?.changes) ? c.diff.changes : [],
                  pagesThatChanged: Array.isArray(c?.diff?.pagesThatChanged)
                    ? c.diff.pagesThatChanged
                        .map((p: any) => ({
                          pageNumber:
                            typeof p?.pageNumber === "number" && Number.isFinite(p.pageNumber)
                              ? Math.floor(p.pageNumber)
                              : null,
                          summary: typeof p?.summary === "string" ? p.summary : "",
                        }))
                        .filter((p: any) => typeof p.pageNumber === "number" && p.pageNumber >= 1)
                    : [],
                  ...(includeText
                    ? {
                        previousText: typeof c.previousText === "string" ? c.previousText : "",
                        newText: typeof c.newText === "string" ? c.newText : "",
                      }
                    : { previousText: "", newText: "" }),
                }
              : {}),
            createdBy: lite
              ? null
              : (function () {
                  const id = c?.createdByUserId ? String(c.createdByUserId) : "";
                  if (!id) return null;
                  return createdByMap.get(id) ?? { id, name: null, email: null };
                })(),
            createdDate: c.createdDate ? new Date(c.createdDate).toISOString() : null,
          })),
          ...(includeChangeList ? { nextCursor } : {}),
          ...(debugInfo ? { debug: debugInfo } : {}),
        },
        { headers: { "cache-control": "no-store" } },
      ),
      actor,
    );
  } catch (err) {
    const actor = await resolveActor(request).catch(() => null);
    const message = err instanceof Error ? err.message : "Unknown error";
    const res = NextResponse.json({ error: message }, { status: 400 });
    return actor ? applyTempUserHeaders(res, actor) : res;
  }
}


