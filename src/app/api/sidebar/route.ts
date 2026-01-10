/**
 * API route for `/api/sidebar`.
 *
 * Returns a single snapshot payload used by the main app left sidebar (docs/projects/requests)
 * so it can render instantly with minimal network overhead.
 */
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { applyTempUserHeaders, resolveActor, tryResolveUserActorFastWithPersonalOrg } from "@/lib/gating/actor";
import { DocModel } from "@/lib/models/Doc";
import { ProjectModel } from "@/lib/models/Project";
import { UploadModel } from "@/lib/models/Upload";
import { debugError, debugLog } from "@/lib/debug";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Paged<T> = { items: T[]; total: number; page: number; limit: number };

type SidebarDocListItem = {
  id: string;
  shareId: string | null;
  title: string;
  status: string | null;
  version: number | null;
  receivedViaRequestProjectId?: string | null;
  guideForRequestProjectId?: string | null;
  updatedDate: string | null;
  createdDate: string | null;
};

type SidebarProjectListItem = {
  id: string;
  name: string;
  slug: string;
  description: string;
  isRequest?: boolean;
  docCount?: number;
  updatedDate: string | null;
  createdDate: string | null;
};

function etagFromJson(v: unknown): string {
  const json = JSON.stringify(v);
  const hash = crypto.createHash("sha1").update(json).digest("hex").slice(0, 16);
  return `W/"${hash}"`;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const sidebar = url.searchParams.get("sidebar") === "1";
    // Default list sizes match the client sidebar cache snapshot.
    const docsLimit = 5;
    const projectsLimit = 10;
    const requestsLimit = 10;

    debugLog(2, "[api/sidebar] GET", { sidebar });
    // Hot path (app left sidebar): avoid heavy resolver; preserve correct personalOrgId for legacy scoping.
    const actor = (await tryResolveUserActorFastWithPersonalOrg(request)) ?? (await resolveActor(request));
    await connectMongo();

    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;

    const scopedOr = allowLegacyByUserId
      ? {
          $or: [
            { orgId },
            { userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
          ],
        }
      : { orgId };

    // Docs (recent)
    const docsFilter: Record<string, unknown> = {
      ...scopedOr,
      isDeleted: { $ne: true },
      isArchived: { $ne: true },
    };

    const [docsTotal, docsRaw] = await Promise.all([
      DocModel.countDocuments(docsFilter),
      DocModel.find(docsFilter)
        .select({
          _id: 1,
          shareId: 1,
          title: 1,
          status: 1,
          currentUploadId: 1,
          uploadId: 1, // legacy
          receivedViaRequestProjectId: 1,
          guideForRequestProjectId: 1,
          updatedDate: 1,
          createdDate: 1,
        })
        .sort({ updatedDate: -1, _id: -1 })
        .limit(docsLimit)
        .lean(),
    ]);

    // Compute version via current upload version (best-effort).
    const currentUploadIds = docsRaw
      .map((d) => d.currentUploadId ?? (d as unknown as { uploadId?: unknown }).uploadId)
      .filter(Boolean);
    const uploadsById = new Map<string, number>();
    if (currentUploadIds.length) {
      const uploads = await UploadModel.find({ _id: { $in: currentUploadIds } })
        .select({ _id: 1, version: 1 })
        .lean();
      for (const u of uploads) {
        const v = (u as { version?: unknown }).version;
        if (Number.isFinite(v)) uploadsById.set(String(u._id), Number(v));
      }
    }

    const docs: Paged<SidebarDocListItem> = {
      items: docsRaw.map((d) => {
        const currentUploadId = d.currentUploadId ?? (d as unknown as { uploadId?: unknown }).uploadId ?? null;
        const receivedViaRequestProjectIdRaw = (d as unknown as { receivedViaRequestProjectId?: unknown }).receivedViaRequestProjectId;
        const guideForRequestProjectIdRaw = (d as unknown as { guideForRequestProjectId?: unknown }).guideForRequestProjectId;
        return {
          id: String(d._id),
          shareId: d.shareId ?? null,
          title: d.title ?? "Untitled document",
          status: d.status ?? "draft",
          version: currentUploadId ? uploadsById.get(String(currentUploadId)) ?? null : null,
          receivedViaRequestProjectId: receivedViaRequestProjectIdRaw ? String(receivedViaRequestProjectIdRaw) : null,
          guideForRequestProjectId: guideForRequestProjectIdRaw ? String(guideForRequestProjectIdRaw) : null,
          updatedDate: d.updatedDate ? new Date(d.updatedDate).toISOString() : null,
          createdDate: d.createdDate ? new Date(d.createdDate).toISOString() : null,
        };
      }),
      total: typeof docsTotal === "number" ? docsTotal : 0,
      page: 1,
      limit: docsLimit,
    };

    // Projects (non-request)
    const projectsFilter: Record<string, unknown> = {
      ...scopedOr,
      $and: [
        { $or: [{ isRequest: { $exists: false } }, { isRequest: { $ne: true } }] },
        { $or: [{ requestUploadToken: { $exists: false } }, { requestUploadToken: null }, { requestUploadToken: "" }] },
      ],
    };
    const [projectsTotal, projectsRaw] = await Promise.all([
      ProjectModel.countDocuments(projectsFilter),
      ProjectModel.find(projectsFilter)
        .select({ _id: 1, name: 1, slug: 1, description: 1, docCount: 1, updatedDate: 1, createdDate: 1 })
        .sort({ updatedDate: -1, _id: -1 })
        .limit(projectsLimit)
        .lean(),
    ]);
    const projects: Paged<SidebarProjectListItem> = {
      items: projectsRaw.map((p) => ({
        id: String(p._id),
        name: (p as { name?: string }).name ?? "",
        slug: (p as { slug?: string }).slug ?? "",
        description: (p as { description?: string }).description ?? "",
        isRequest: false,
        docCount: (function () {
          const raw = (p as unknown as { docCount?: unknown }).docCount;
          return Number.isFinite(raw) ? Number(raw) : 0;
        })(),
        updatedDate: (p as unknown as { updatedDate?: unknown }).updatedDate
          ? new Date(String((p as unknown as { updatedDate?: unknown }).updatedDate)).toISOString()
          : null,
        createdDate: (p as unknown as { createdDate?: unknown }).createdDate
          ? new Date(String((p as unknown as { createdDate?: unknown }).createdDate)).toISOString()
          : null,
      })),
      total: typeof projectsTotal === "number" ? projectsTotal : 0,
      page: 1,
      limit: projectsLimit,
    };

    // Requests (request repos)
    const requestOnly = { $or: [{ isRequest: true }, { requestUploadToken: { $exists: true, $nin: [null, ""] } }] };
    const requestsFilter: Record<string, unknown> = {
      ...scopedOr,
      $and: [requestOnly],
    };
    const [requestsTotal, requestsRaw] = await Promise.all([
      ProjectModel.countDocuments(requestsFilter),
      ProjectModel.find(requestsFilter)
        .select({ _id: 1, name: 1, slug: 1, description: 1, docCount: 1, updatedDate: 1, createdDate: 1 })
        .sort({ updatedDate: -1, _id: -1 })
        .limit(requestsLimit)
        .lean(),
    ]);
    const requests: Paged<SidebarProjectListItem> = {
      items: requestsRaw.map((p) => ({
        id: String(p._id),
        name: (p as { name?: string }).name ?? "",
        slug: (p as { slug?: string }).slug ?? "",
        description: (p as { description?: string }).description ?? "",
        isRequest: true,
        docCount: (function () {
          const raw = (p as unknown as { docCount?: unknown }).docCount;
          return Number.isFinite(raw) ? Number(raw) : 0;
        })(),
        updatedDate: (p as unknown as { updatedDate?: unknown }).updatedDate
          ? new Date(String((p as unknown as { updatedDate?: unknown }).updatedDate)).toISOString()
          : null,
        createdDate: (p as unknown as { createdDate?: unknown }).createdDate
          ? new Date(String((p as unknown as { createdDate?: unknown }).createdDate)).toISOString()
          : null,
      })),
      total: typeof requestsTotal === "number" ? requestsTotal : 0,
      page: 1,
      limit: requestsLimit,
    };

    const payload = { docs, projects, requests };
    const etag = etagFromJson(payload);
    const ifNoneMatch = request.headers.get("if-none-match") ?? "";
    const cacheControl = sidebar ? "private, max-age=0, must-revalidate" : "no-store";

    if (ifNoneMatch && ifNoneMatch === etag) {
      return applyTempUserHeaders(
        new NextResponse(null, {
          status: 304,
          headers: {
            etag,
            "cache-control": cacheControl,
          },
        }),
        actor,
      );
    }

    return applyTempUserHeaders(
      NextResponse.json(payload, {
        headers: {
          etag,
          "cache-control": cacheControl,
        },
      }),
      actor,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/sidebar] GET failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


