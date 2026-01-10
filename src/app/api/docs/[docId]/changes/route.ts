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
    const limitParam = url.searchParams.get("limit");
    const limit = Math.max(1, Math.min(50, Number.isFinite(Number(limitParam)) ? Number(limitParam) : 50));

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
      .select({ _id: 1, title: 1, currentUploadVersion: 1 })
      .lean();
    if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Modes:
    // - lite=1: used by doc page replace banner; cheapest possible (no joins, no change list).
    // - noText=1: used by history page; includes change list but omits large text blobs.
    // - default: full payload (includes text blobs, createdBy, etc).
    const includeChangeList = !lite;
    const includeText = !lite && !noText;

    const changeFilter: Record<string, unknown> = {
      docId: docObjectId,
      ...(allowLegacyByUserId ? {} : { orgId }),
    };
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

    const changesAgg = (await DocChangeModel.find(changeFilter)
      .select(changeSelect)
      .sort({ toVersion: -1, createdDate: -1 })
      .limit(limit)
      .lean()) as Array<Record<string, any>>;

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


