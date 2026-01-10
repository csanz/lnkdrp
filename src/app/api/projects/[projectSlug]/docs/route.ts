/**
 * API route for `/api/projects/:projectSlug/docs`.
 *
 * Lists docs within a project and backfills a public `/p/:shareId` if missing.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import crypto from "node:crypto";
import { connectMongo } from "@/lib/mongodb";
import { ProjectModel } from "@/lib/models/Project";
import { DocModel } from "@/lib/models/Doc";
import { UploadModel } from "@/lib/models/Upload";
import { ReviewModel } from "@/lib/models/Review";
import { debugError, debugLog } from "@/lib/debug";
import { applyTempUserHeaders, resolveActor, tryResolveUserActorFastWithPersonalOrg } from "@/lib/gating/actor";

export const runtime = "nodejs";

const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/**
 * Random Base62 (uses randomBytes, max, ceil).
 */


function randomBase62(length: number): string {
  let out = "";
  while (out.length < length) {
    const remaining = length - out.length;
    const buf = crypto.randomBytes(Math.max(8, Math.ceil(remaining * 1.25)));
    for (const b of buf) {
      // 62 * 4 = 248, so values 0..247 map evenly to base62.
      if (b < 248) out += BASE62_ALPHABET[b % 62];
      if (out.length >= length) break;
    }
  }
  return out;
}
/**
 * Escape Regex (uses replace).
 */


function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
 * Slugify (uses slice, replace, toLowerCase).
 */


function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
/**
 * Handle GET requests.
 */


export async function GET(
  request: Request,
  ctx: { params: Promise<{ projectSlug: string }> },
) {
  try {
    const { projectSlug } = await ctx.params;
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    const pageRaw = url.searchParams.get("page");
    const qRaw = url.searchParams.get("q") ?? "";
    const limit = Math.max(
      1,
      Math.min(50, Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 25),
    );
    const page = Math.max(1, Number.isFinite(Number(pageRaw)) ? Number(pageRaw) : 1);
    const q = qRaw.trim();

    debugLog(2, "[api/projects/:slug/docs] GET", {
      projectSlug,
      limit,
      page,
      q: q ? "[redacted]" : "",
    });

    // Hot path (/project/:id): avoid heavy resolver; preserve correct personalOrgId for legacy scoping.
    const actor = (await tryResolveUserActorFastWithPersonalOrg(request)) ?? (await resolveActor(request));
    await connectMongo();

    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
    const projectIdParam = decodeURIComponent(projectSlug).trim();
    if (!Types.ObjectId.isValid(projectIdParam)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    let project = await ProjectModel.findOne(
      allowLegacyByUserId
        ? {
            $or: [
              { _id: new Types.ObjectId(projectIdParam), orgId },
              {
                _id: new Types.ObjectId(projectIdParam),
                userId: legacyUserId,
                $or: [{ orgId: { $exists: false } }, { orgId: null }],
              },
            ],
          }
        : { _id: new Types.ObjectId(projectIdParam), orgId },
    )
      .select({
        _id: 1,
        shareId: 1,
        name: 1,
        slug: 1,
        description: 1,
        docCount: 1,
        autoAddFiles: 1,
        isRequest: 1,
        requestUploadToken: 1,
        requestViewToken: 1,
        requestReviewEnabled: 1,
        requestReviewPrompt: 1,
        requestReviewGuideDocId: 1,
      })
      .lean();

    if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Best-effort: backfill orgId for legacy personal projects.
    if (allowLegacyByUserId && !(project as unknown as { orgId?: unknown }).orgId) {
      try {
        await ProjectModel.updateOne(
          { _id: project._id, userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
          { $set: { orgId } },
        );
        (project as unknown as { orgId?: Types.ObjectId }).orgId = orgId;
      } catch {
        // ignore
      }
    }

    // Best-effort: backfill shareId for older projects.
    const projectShareId = (project as unknown as { shareId?: unknown }).shareId;
    if (!(typeof projectShareId === "string" && projectShareId.trim())) {
      try {
        const nextShareId = randomBase62(12);
        await ProjectModel.updateOne(
          {
            _id: project._id,
            ...(allowLegacyByUserId
              ? {
                  $or: [
                    { orgId },
                    { userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
                  ],
                }
              : { orgId }),
            $or: [{ shareId: { $exists: false } }, { shareId: null }, { shareId: "" }],
          },
          { $set: { shareId: nextShareId } },
        );
        (project as unknown as { shareId?: string }).shareId = nextShareId;
      } catch {
        // ignore; collision/other failure will just keep link empty
      }
    }

    // Request-project settings (best-effort enrich, used by client UIs).
    let requestSettings: {
      uploadPath: string | null;
      viewPath: string | null;
      requireAuthToUpload: boolean;
      reviewEnabled: boolean;
      reviewPrompt: string;
      guideDocId: string | null;
      guideDocTitle: string | null;
    } | null = null;
    try {
      const isRequest =
        Boolean((project as unknown as { isRequest?: unknown }).isRequest) ||
        Boolean(
          typeof (project as unknown as { requestUploadToken?: unknown }).requestUploadToken === "string" &&
            String((project as unknown as { requestUploadToken?: string }).requestUploadToken ?? "").trim(),
        );
      if (isRequest) {
        const tokenRaw = (project as unknown as { requestUploadToken?: unknown }).requestUploadToken;
        const token = typeof tokenRaw === "string" && tokenRaw.trim() ? tokenRaw.trim() : "";
        const uploadPath = token ? `/request/${encodeURIComponent(token)}` : null;

        // View-only link token (best-effort backfill for older request repos).
        let viewToken = "";
        const viewTokenRaw = (project as unknown as { requestViewToken?: unknown }).requestViewToken;
        if (typeof viewTokenRaw === "string" && viewTokenRaw.trim()) {
          viewToken = viewTokenRaw.trim();
        } else {
          try {
            const next = randomBase62(32);
            await ProjectModel.updateOne(
              {
                _id: project._id,
                ...(allowLegacyByUserId
                  ? {
                      $or: [
                        { orgId },
                        { userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
                      ],
                    }
                  : { orgId }),
                $or: [{ requestViewToken: { $exists: false } }, { requestViewToken: null }, { requestViewToken: "" }],
              },
              { $set: { requestViewToken: next } },
            );
            viewToken = next;
          } catch {
            // ignore; best-effort
          }
        }
        const viewPath = viewToken ? `/request-view/${encodeURIComponent(viewToken)}` : null;

        const requireAuthToUpload = Boolean(
          (project as unknown as { requestRequireAuthToUpload?: unknown }).requestRequireAuthToUpload,
        );
        const reviewEnabled = Boolean((project as unknown as { requestReviewEnabled?: unknown }).requestReviewEnabled);
        const reviewPromptRaw = (project as unknown as { requestReviewPrompt?: unknown }).requestReviewPrompt;
        const reviewPrompt =
          typeof reviewPromptRaw === "string" && reviewPromptRaw.trim() ? reviewPromptRaw.trim() : "";

        const guideDocIdRaw = (project as unknown as { requestReviewGuideDocId?: unknown }).requestReviewGuideDocId;
        const guideDocId = guideDocIdRaw ? String(guideDocIdRaw) : "";
        let guideDocTitle: string | null = null;
        if (guideDocId && Types.ObjectId.isValid(guideDocId)) {
          const guide = await DocModel.findOne({
            _id: new Types.ObjectId(guideDocId),
            ...(allowLegacyByUserId
              ? {
                  $or: [
                    { orgId },
                    { userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
                  ],
                }
              : { orgId }),
            isDeleted: { $ne: true },
          })
            .select({ title: 1 })
            .lean();
          const t = guide && typeof guide.title === "string" ? guide.title.trim() : "";
          guideDocTitle = t || null;
        }

        requestSettings = {
          uploadPath,
          viewPath,
          requireAuthToUpload,
          reviewEnabled,
          reviewPrompt,
          guideDocId: guideDocId || null,
          guideDocTitle,
        };
      }
    } catch {
      // ignore; best-effort
    }

    const filter: Record<string, unknown> = {
      ...(allowLegacyByUserId
        ? {
            $or: [
              { orgId },
              { userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
            ],
          }
        : { orgId }),
      isDeleted: { $ne: true },
      isArchived: { $ne: true },
      $and: [
        // Backward-compat: old docs only have `projectId`; new docs use `projectIds[]`.
        { $or: [{ projectId: project._id }, { projectIds: project._id }] },
      ],
    };
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      (filter.$and as Array<Record<string, unknown>>).push({ $or: [{ title: rx }, { shareId: rx }] });
    }

    // Perf: avoid an extra `countDocuments` query on the hot path.
    // `Project.docCount` is maintained by write paths specifically so list UIs don't have to count.
    const projectDocCountRaw = (project as unknown as { docCount?: unknown }).docCount;
    const projectDocCount =
      typeof projectDocCountRaw === "number" && Number.isFinite(projectDocCountRaw) ? projectDocCountRaw : null;

    const docsQuery = DocModel.find(filter)
      .select({
        _id: 1,
        orgId: 1,
        userId: 1,
        shareId: 1,
        title: 1,
        status: 1,
        currentUploadId: 1,
        uploadId: 1, // legacy
        previewImageUrl: 1,
        firstPagePngUrl: 1,
        projectId: 1,
        projectIds: 1,
        updatedDate: 1,
        createdDate: 1,
        "aiOutput.summary": 1,
      })
      .sort({ updatedDate: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const [total, docs] = q
      ? await Promise.all([DocModel.countDocuments(filter), docsQuery])
      : [projectDocCount ?? (await DocModel.countDocuments(filter)), await docsQuery];

    // Add current upload versions (best-effort), same as /api/docs.
    const currentUploadIds = docs
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

    // For request repos: include a latest "reviewScore" so the UI can sort/filter.
    // - New agent output: map relevancy low/medium/high -> 1/2/3.
    // - Legacy output: fall back to intel.effectivenessScore (number).
    const isRequestProject =
      Boolean((project as unknown as { isRequest?: unknown }).isRequest) ||
      Boolean(
        typeof (project as unknown as { requestUploadToken?: unknown }).requestUploadToken === "string" &&
          String((project as unknown as { requestUploadToken?: string }).requestUploadToken ?? "").trim(),
      );
    const reviewScoreByDocId = new Map<string, number>();
    if (isRequestProject && docs.length) {
      try {
        const docObjectIds = docs
          .map((d) => (d && (d as { _id?: unknown })._id ? String((d as { _id: unknown })._id) : ""))
          .filter((id) => Types.ObjectId.isValid(id))
          .map((id) => new Types.ObjectId(id));

        const rows = await ReviewModel.aggregate([
          {
            $match: {
              docId: { $in: docObjectIds },
              status: "completed",
              $or: [
                { "agentOutput.relevancy": { $in: ["low", "medium", "high"] } },
                { "intel.effectivenessScore": { $type: "number" } },
              ],
            },
          },
          { $sort: { docId: 1, version: -1, createdDate: -1 } },
          {
            $group: {
              _id: "$docId",
              relevancy: { $first: "$agentOutput.relevancy" },
              legacyScore: { $first: "$intel.effectivenessScore" },
            },
          },
        ]);

        for (const r of rows) {
          const id = r && r._id ? String(r._id) : "";
          const rel = r && typeof r.relevancy === "string" ? String(r.relevancy) : "";
          const mapped =
            rel === "high" ? 3 : rel === "medium" ? 2 : rel === "low" ? 1 : null;
          const legacy =
            r && typeof r.legacyScore === "number" && Number.isFinite(r.legacyScore) ? r.legacyScore : null;
          const score = mapped ?? legacy;
          if (id && score !== null) reviewScoreByDocId.set(id, score);
        }
      } catch {
        // ignore; best-effort
      }
    }

    const payload = {
      project: {
        id: String(project._id),
        shareId: (project as unknown as { shareId?: unknown }).shareId ?? null,
        name: project.name ?? "",
        slug: project.slug ?? "",
        description: project.description ?? "",
        autoAddFiles: Boolean((project as unknown as { autoAddFiles?: unknown }).autoAddFiles),
        isRequest: Boolean((project as unknown as { isRequest?: unknown }).isRequest),
        request: requestSettings,
      },
      total,
      page,
      limit,
      docs: docs.map((d) => {
        const currentUploadId =
          d.currentUploadId ?? (d as unknown as { uploadId?: unknown }).uploadId ?? null;
        const previewImageUrlRaw =
          d.previewImageUrl ?? (d as unknown as { firstPagePngUrl?: unknown }).firstPagePngUrl ?? null;
        const previewImageUrl = typeof previewImageUrlRaw === "string" ? previewImageUrlRaw : null;
        const ai = (d as unknown as { aiOutput?: unknown }).aiOutput;
        const summary =
          ai && typeof ai === "object"
            ? ((ai as { summary?: unknown }).summary ?? null)
            : null;
        const projectIdsRaw = (d as unknown as { projectIds?: unknown }).projectIds;
        const projectIds = Array.isArray(projectIdsRaw)
          ? projectIdsRaw.map((x) => String(x))
          : [];
        const legacyProjectId = (d as unknown as { projectId?: unknown }).projectId;
        const allProjectIds = [
          ...(legacyProjectId ? [String(legacyProjectId)] : []),
          ...projectIds,
        ].filter(Boolean);
        const uniqueProjectIds = Array.from(new Set(allProjectIds));
        return {
          id: String(d._id),
          shareId: d.shareId ?? null,
          title: d.title ?? "Untitled document",
          summary: typeof summary === "string" ? summary : null,
          status: d.status ?? "draft",
          projectIds: uniqueProjectIds,
          previewImageUrl,
          currentUploadId: currentUploadId ? String(currentUploadId) : null,
          version: currentUploadId ? uploadsById.get(String(currentUploadId)) ?? null : null,
          reviewScore: isRequestProject ? reviewScoreByDocId.get(String(d._id)) ?? null : null,
          updatedDate: d.updatedDate ? new Date(d.updatedDate).toISOString() : null,
          createdDate: d.createdDate ? new Date(d.createdDate).toISOString() : null,
        };
      }),
    };

    // ETag/304: lets clients avoid re-downloading JSON unless the payload truly changed.
    const hash = crypto.createHash("sha1").update(JSON.stringify(payload)).digest("base64url");
    const etag = `W/"${hash}"`;
    const inm = request.headers.get("if-none-match") ?? "";
    const cacheControl = "private, max-age=0, must-revalidate";

    if (inm === etag) {
      const res = new NextResponse(null, { status: 304 });
      res.headers.set("etag", etag);
      res.headers.set("cache-control", cacheControl);
      return applyTempUserHeaders(res, actor);
    }

    const res = NextResponse.json(payload);
    res.headers.set("etag", etag);
    res.headers.set("cache-control", cacheControl);
    return applyTempUserHeaders(res, actor);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/projects/:slug/docs] GET failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}




