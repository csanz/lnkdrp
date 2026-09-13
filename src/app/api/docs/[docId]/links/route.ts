/**
 * Share links of one document — `GET`/`POST /api/docs/:docId/links`
 * (docs/prds/lnkdrp-multi-links.md).
 *
 * A document owns any number of links, each with its own label, audience, settings and analytics.
 * All the rules (the Free "3 active links" cap, the 50-per-document guard, validation, keeping
 * `Doc.shareEnabled` coherent) live in `src/lib/share/links.ts`; this route is authorization,
 * shape and activity only.
 *
 * Creating at the cap is never an error: the service creates the link **disabled** and reports
 * `limit.ok === false`, which comes back as `201 { link, planWarning }` so the UI can show the
 * upgrade prompt with the link already in the list.
 */
import { NextResponse } from "next/server";

import { applyTempUserHeaders } from "@/lib/gating/actor";
import { recordActivity } from "@/lib/activity/log";
import { createShareLink, listShareLinks, toShareLinkDTO } from "@/lib/share/links";
import { accessDocForLinks, linkErrorResponse, planWarningOf } from "./shared";
import { planLimitResponse } from "@/lib/billing/planLimits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where a link was created from, for the link row's `createdVia`.
 *
 * A bearer API key means an agent (`mcp` when it also identified itself with `x-lnkdrp-agent`,
 * which every MCP session sends); a cookie session is the web app.
 */
function createdViaFor(request: Request): "web" | "api" | "mcp" {
  const bearer = (request.headers.get("authorization") ?? "").toLowerCase().startsWith("bearer ");
  if (!bearer) return "web";
  return request.headers.get("x-lnkdrp-agent") ? "mcp" : "api";
}

/**
 * `GET /api/docs/:docId/links`
 *
 * Every link of the document, default first then newest first. Archived links are omitted unless
 * `?includeArchived=1`. Readable by any member of the workspace (viewers included).
 * Out: `{ links: ShareLinkDTO[] }`.
 */
export async function GET(request: Request, ctx: { params: Promise<{ docId: string }> }) {
  const { docId } = await ctx.params;
  const gate = await accessDocForLinks(request, docId, "viewer");
  if (!gate.ok) return gate.response;
  const { actor, docId: docObjectId, orgId } = gate.access;
  try {
    const includeArchived = new URL(request.url).searchParams.get("includeArchived") === "1";
    const links = await listShareLinks({ orgId, docId: docObjectId, includeArchived });
    return applyTempUserHeaders(
      NextResponse.json({ links: links.map(toShareLinkDTO) }, { headers: { "cache-control": "no-store" } }),
      actor,
    );
  } catch (err) {
    return linkErrorResponse(err, actor);
  }
}

/**
 * `POST /api/docs/:docId/links`
 *
 * In: `{ label, audience?, enabled? = true, allowDownload? = false, allowRevisionHistory? = false,
 * expiresAt?: ISO|null, password?: string|null }`.
 * Out: `201 { link, planWarning? }`. Viewers are refused (403); `label` is required (400);
 * more than 50 links on one document is a 409.
 */
export async function POST(request: Request, ctx: { params: Promise<{ docId: string }> }) {
  const { docId } = await ctx.params;
  const gate = await accessDocForLinks(request, docId, "member");
  if (!gate.ok) return gate.response;
  const { actor, docId: docObjectId, orgId, title } = gate.access;
  try {
    const body = (await request.json().catch(() => ({}))) as Partial<{
      label: string;
      audience: string | null;
      enabled: boolean;
      allowDownload: boolean;
      allowRevisionHistory: boolean;
      expiresAt: string | null;
      password: string | null;
    }>;

    const { link, limit } = await createShareLink({
      orgId,
      docId: docObjectId,
      userId: actor.userId,
      createdVia: createdViaFor(request),
      settings: {
        label: typeof body.label === "string" ? body.label : "",
        ...(body.audience !== undefined ? { audience: body.audience } : {}),
        ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
        ...(typeof body.allowDownload === "boolean" ? { allowDownload: body.allowDownload } : {}),
        ...(typeof body.allowRevisionHistory === "boolean" ? { allowRevisionHistory: body.allowRevisionHistory } : {}),
        ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
        ...(body.password !== undefined ? { password: body.password } : {}),
      },
    });

    // A plan limit refused the create (today: recipient version history on Free). Answer 402 with
    // the standard plan_limit body, exactly as the document-level PATCH does.
    if (!link) return applyTempUserHeaders(planLimitResponse(limit as Parameters<typeof planLimitResponse>[0]), actor);

    const dto = toShareLinkDTO(link);
    void recordActivity({
      orgId: String(orgId),
      userId: actor.userId,
      actorKind: actor.kind,
      type: "share_link.created",
      docId: docObjectId,
      title,
      meta: { linkId: dto.id, shareId: dto.shareId, linkLabel: dto.label, audience: dto.audience, enabled: dto.enabled },
      request,
    });

    const planWarning = planWarningOf(limit);
    return applyTempUserHeaders(
      NextResponse.json(
        { link: dto, ...(planWarning ? { planWarning } : {}) },
        { status: 201, headers: { "cache-control": "no-store" } },
      ),
      actor,
    );
  } catch (err) {
    return linkErrorResponse(err, actor);
  }
}
