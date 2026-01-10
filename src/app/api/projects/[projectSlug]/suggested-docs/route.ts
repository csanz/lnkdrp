import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { ProjectModel } from "@/lib/models/Project";
import { DocModel } from "@/lib/models/Doc";
import { debugError, debugLog } from "@/lib/debug";
import { applyTempUserHeaders, resolveActor, tryResolveUserActorFastWithPersonalOrg } from "@/lib/gating/actor";

export const runtime = "nodejs";
/**
 * Escape Regex (uses replace).
 */


function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const STOPWORDS = new Set(
  [
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "but",
    "by",
    "for",
    "from",
    "has",
    "have",
    "how",
    "i",
    "if",
    "in",
    "into",
    "is",
    "it",
    "its",
    "me",
    "my",
    "of",
    "on",
    "or",
    "our",
    "related",
    "so",
    "that",
    "the",
    "their",
    "then",
    "this",
    "to",
    "us",
    "was",
    "we",
    "were",
    "what",
    "when",
    "where",
    "which",
    "who",
    "why",
    "with",
    "you",
    "your",
    // Common filler words in project descriptions
    "document",
    "documents",
    "file",
    "files",
    "folder",
    "project",
  ].map((s) => s.toLowerCase()),
);
/**
 * Extract Project Search Tags (uses toLowerCase, filter, split).
 */


function extractProjectSearchTags(name: string, description: string): string[] {
  const text = `${name}\n${description}`.toLowerCase();
  const tokens = text
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/g)
    .filter(Boolean);

  const freq = new Map<string, number>();
  for (const t of tokens) {
    if (t.length < 3) continue;
    if (STOPWORDS.has(t)) continue;
    if (/^\d+$/.test(t)) continue;
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }

  // Prefer higher-frequency, longer tokens, but keep a small cap to avoid noisy queries.
  return Array.from(freq.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      if (b[0].length !== a[0].length) return b[0].length - a[0].length;
      return a[0].localeCompare(b[0]);
    })
    .map(([t]) => t)
    .slice(0, 8);
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
    const projectIdParam = decodeURIComponent(projectSlug).trim();
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    const limit = Math.max(1, Math.min(50, Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 12));

    debugLog(2, "[api/projects/:id/suggested-docs] GET", { projectId: projectIdParam, limit });

    // Hot path (project settings): avoid heavy resolver; preserve correct personalOrgId for legacy scoping.
    const actor = (await tryResolveUserActorFastWithPersonalOrg(request)) ?? (await resolveActor(request));
    await connectMongo();

    if (!Types.ObjectId.isValid(projectIdParam)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
    const projectId = new Types.ObjectId(projectIdParam);
    const project = await ProjectModel.findOne(
      allowLegacyByUserId
        ? {
            $or: [
              { _id: projectId, orgId },
              { _id: projectId, userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
            ],
          }
        : { _id: projectId, orgId },
    )
      .select({ _id: 1, name: 1, description: 1 })
      .lean();
    if (!project) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    const name = project.name ?? "";
    const description = project.description ?? "";
    const tags = extractProjectSearchTags(name, description);
    if (!tags.length) {
      return applyTempUserHeaders(NextResponse.json({ tags: [], docs: [] }), actor);
    }

    // IMPORTANT: avoid regex scans over the docs collection.
    // Prefer exact tag matches (fast + indexable) and do project-exclusion in-memory.
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
      "aiOutput.tags": { $in: tags },
    };

    // Overfetch so we can (a) drop docs already in the project and (b) rank by match count.
    const overfetch = Math.min(250, Math.max(limit * 20, 60));
    const docs = await DocModel.find(filter)
      .sort({ updatedDate: -1, _id: -1 })
      .limit(overfetch)
      .select({
        _id: 1,
        title: 1,
        shareId: 1,
        status: 1,
        updatedDate: 1,
        createdDate: 1,
        previewImageUrl: 1,
        firstPagePngUrl: 1,
        projectId: 1,
        projectIds: 1,
        "aiOutput.tags": 1,
        "aiOutput.summary": 1,
      })
      .lean();

    const tagSet = new Set(tags.map((t) => t.toLowerCase()));
    const scored = docs
      .filter((d) => {
        // Exclude docs already in this project (primary or membership).
        const primary = (d as unknown as { projectId?: unknown }).projectId;
        if (primary && String(primary) === String(projectId)) return false;
        const memberships = (d as unknown as { projectIds?: unknown }).projectIds;
        if (Array.isArray(memberships) && memberships.some((x) => String(x) === String(projectId))) return false;
        return true;
      })
      .map((d) => {
        const ai = (d as unknown as { aiOutput?: unknown }).aiOutput;
        const aiTagsRaw =
          ai && typeof ai === "object" ? (ai as { tags?: unknown }).tags : null;
        const aiTags = Array.isArray(aiTagsRaw) ? aiTagsRaw.filter((x) => typeof x === "string") as string[] : [];
        const loweredAiTags = aiTags.map((t) => t.toLowerCase());

        let matchCount = 0;
        for (const t of tagSet) {
          if (loweredAiTags.some((docTag) => docTag.includes(t))) matchCount++;
        }

        const summary =
          ai && typeof ai === "object" ? ((ai as { summary?: unknown }).summary ?? null) : null;
        const previewImageUrlRaw =
          (d as unknown as { previewImageUrl?: unknown }).previewImageUrl ??
          (d as unknown as { firstPagePngUrl?: unknown }).firstPagePngUrl ??
          null;
        const previewImageUrl = typeof previewImageUrlRaw === "string" ? previewImageUrlRaw : null;

        return {
          id: String(d._id),
          shareId: d.shareId ?? null,
          title: d.title ?? "Untitled document",
          status: d.status ?? "draft",
          updatedDate: d.updatedDate ? new Date(d.updatedDate).toISOString() : null,
          createdDate: d.createdDate ? new Date(d.createdDate).toISOString() : null,
          summary: typeof summary === "string" ? summary : null,
          previewImageUrl,
          matchCount,
        };
      })
      .filter((d) => d.matchCount > 0)
      .sort((a, b) => {
        if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
        return (b.updatedDate ?? "").localeCompare(a.updatedDate ?? "");
      })
      .slice(0, limit);

    return applyTempUserHeaders(NextResponse.json({ tags, docs: scored }), actor);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/projects/:id/suggested-docs] GET failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


