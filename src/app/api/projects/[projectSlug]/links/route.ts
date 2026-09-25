/**
 * Share links of one project — `GET`/`POST /api/projects/:projectId/links`
 * (docs/prds/lnkdrp-project-links.md, milestone M1).
 *
 * A project owns any number of links, each with its own label, audience, password, expiry and
 * download setting, all resolving to `/p/:shareId`. Every rule (the 50-per-project guard,
 * validation, the Pro gate, keeping `Project.shareEnabled` coherent) lives in
 * `src/lib/share/projectLinks.ts`; this route is authorization, shape and activity only.
 *
 * Unlike document links, creating one is a plan decision: `POST` answers `402 plan_limit`
 * (`limit: "project_links"`) on Free, which `parsePlanLimitError` + the upgrade modal already know
 * how to render. Nothing is written in that case — the project's default link is untouched and
 * keeps working, which is the whole Free story for this feature.
 *
 * Works for session cookies and API keys alike: `resolveActor` inside `accessProjectForLinks`
 * handles both, so the MCP reaches these routes with no special case.
 */
import { NextResponse } from "next/server";

import { applyTempUserHeaders } from "@/lib/gating/actor";
import { recordActivity } from "@/lib/activity/log";
import { createProjectLink, listProjectLinksPage, projectLinkStatsByShareId, toProjectLinkDTO } from "@/lib/share/projectLinks";
import { planLimitResponse } from "@/lib/billing/planLimits";
import { createdViaFor } from "@/lib/share/createdVia";
import { accessProjectForLinks, linkErrorResponse } from "./shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/projects/:projectId/links`
 *
 * Page-based, default link first then newest first (`?page=&limit=`, default 25, max 100).
 * Archived links are omitted unless `?includeArchived=1`; `?q=` full-text searches this project's
 * links by label/audience instead of paging through them. Readable by any member of the workspace,
 * viewers included — reading who a project was sent to is not an edit.
 * Out: `{ total, page, limit, links: ProjectLinkDTO[] }`.
 */
export async function GET(request: Request, ctx: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await ctx.params;
  const gate = await accessProjectForLinks(request, projectSlug, "viewer");
  if (!gate.ok) return gate.response;
  const { actor, projectId, orgId } = gate.access;
  try {
    const params = new URL(request.url).searchParams;
    const pageParam = Number(params.get("page"));
    const limitParam = Number(params.get("limit"));
    const query = (params.get("q") ?? "").trim();
    const { total, page, limit, links } = await listProjectLinksPage({
      orgId,
      projectId,
      includeArchived: params.get("includeArchived") === "1",
      page: Number.isFinite(pageParam) ? pageParam : undefined,
      limit: Number.isFinite(limitParam) ? limitParam : undefined,
      query: query || undefined,
    });
    // One aggregation for this page's links, so every row's traffic comes from the same analytics
    // rows the metrics page will read — the document links table learned this the hard way when it
    // served the stored counters and disagreed with itself. Scoped to this page's shareIds.
    const stats = await projectLinkStatsByShareId(links.map((l) => l.shareId));
    return applyTempUserHeaders(
      NextResponse.json(
        { total, page, limit, links: links.map((l) => toProjectLinkDTO(l, stats.get(l.shareId) ?? null)) },
        { headers: { "cache-control": "no-store" } },
      ),
      actor,
    );
  } catch (err) {
    return linkErrorResponse(err, actor);
  }
}

/**
 * `POST /api/projects/:projectId/links`
 *
 * In: `{ label, audience?, enabled? = true, allowDownload? = false, expiresAt?: ISO|null,
 * password?: string|null }`.
 * Out: `201 { link }`. Viewers and members are refused (403 — writes are owner/admin); `label` is
 * required (400); more than 50 links on one project is a 409; Free is a 402 `plan_limit`.
 */
export async function POST(request: Request, ctx: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await ctx.params;
  const gate = await accessProjectForLinks(request, projectSlug, "admin");
  if (!gate.ok) return gate.response;
  const { actor, projectId, orgId, name } = gate.access;
  try {
    const body = (await request.json().catch(() => ({}))) as Partial<{
      label: string;
      audience: string | null;
      enabled: boolean;
      allowDownload: boolean;
      expiresAt: string | null;
      password: string | null;
    }>;

    const { link, limit } = await createProjectLink({
      orgId,
      projectId,
      userId: actor.userId,
      createdVia: createdViaFor(request),
      settings: {
        label: typeof body.label === "string" ? body.label : "",
        ...(body.audience !== undefined ? { audience: body.audience } : {}),
        ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
        ...(typeof body.allowDownload === "boolean" ? { allowDownload: body.allowDownload } : {}),
        ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
        ...(body.password !== undefined ? { password: body.password } : {}),
      },
    });

    // Free: nothing was written, so this is a hard 402 rather than the 200 + `planWarning` the
    // document routes answer with. There is no half-created project link to warn about.
    if (!link) {
      return applyTempUserHeaders(
        planLimitResponse(limit as Parameters<typeof planLimitResponse>[0], {
          orgId: actor.orgId,
          userId: actor.userId,
          actorKind: actor.kind,
          projectId,
          request,
        }),
        actor,
      );
    }

    const dto = toProjectLinkDTO(link, (await projectLinkStatsByShareId([link.shareId])).get(link.shareId) ?? null);
    void recordActivity({
      orgId: String(orgId),
      userId: actor.userId,
      actorKind: actor.kind,
      type: "share_link.created",
      projectId,
      title: name,
      meta: { scope: "project", linkId: dto.id, shareId: dto.shareId, linkLabel: dto.label, audience: dto.audience, enabled: dto.enabled, projectName: name },
      request,
    });

    return applyTempUserHeaders(NextResponse.json({ link: dto }, { status: 201, headers: { "cache-control": "no-store" } }), actor);
  } catch (err) {
    return linkErrorResponse(err, actor);
  }
}
