/**
 * Share links of one document — `GET`/`POST /api/docs/:docId/links`
 * (docs/prds/lnkdrp-multi-links.md).
 *
 * A document owns any number of links, each with its own label, audience, settings and analytics.
 * All the rules (the 50-per-document guard, validation, keeping
 * `Doc.shareEnabled` coherent) live in `src/lib/share/links.ts`; this route is authorization,
 * shape and activity only.
 *
 * Creating at the cap is never an error: the service creates the link **disabled** and reports
 * `limit.ok === false`, which comes back as `201 { link, planWarning }` so the UI can show the
 * upgrade prompt with the link already in the list.
 */
import { NextResponse, after } from "next/server";

import { applyTempUserHeaders } from "@/lib/gating/actor";
import { recordActivity } from "@/lib/activity/log";
import { enqueueSlackPosts } from "@/lib/slack/outbox";
import { createShareLink, listShareLinksPage, shareLinkStatsByShareId, toShareLinkDTO } from "@/lib/share/links";
import { accessDocForLinks, linkErrorResponse, planWarningOf } from "./shared";
import { planLimitResponse } from "@/lib/billing/planLimits";
import { createdViaFor } from "@/lib/share/createdVia";
import { forbidWaitlisted } from "@/lib/gating/waitlist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/docs/:docId/links`
 *
 * Page-based, default link first then newest first, same as `GET /api/docs` (`?page=&limit=`,
 * default 25, max 100). Archived links are omitted unless `?includeArchived=1`. Readable by any
 * member of the workspace (viewers included). A document can carry hundreds of links, and this is
 * the one route a client cannot ask for "all of them" and get away with rendering the answer — the
 * sort/skip/limit happens in Mongo, so `total` can be in the thousands while `links` never is.
 * `?q=` (mt_9ceLy7DqEr) full-text searches this document's links by label/audience instead of
 * paging through them — the search a person actually wants once a document owns more than a few
 * ("which one was Sequoia?"); ranked by relevance, `page` is ignored while `q` is set.
 * Out: `{ total, page, limit, links: ShareLinkDTO[] }`.
 */
export async function GET(request: Request, ctx: { params: Promise<{ docId: string }> }) {
  const { docId } = await ctx.params;
  const gate = await accessDocForLinks(request, docId, "viewer");
  if (!gate.ok) return gate.response;
  const { actor, docId: docObjectId, orgId } = gate.access;
  try {
    const params = new URL(request.url).searchParams;
    const includeArchived = params.get("includeArchived") === "1";
    const pageParam = Number(params.get("page"));
    const limitParam = Number(params.get("limit"));
    const query = (params.get("q") ?? "").trim();
    const { total, page, limit, links } = await listShareLinksPage({
      orgId,
      docId: docObjectId,
      includeArchived,
      page: Number.isFinite(pageParam) ? pageParam : undefined,
      limit: Number.isFinite(limitParam) ? limitParam : undefined,
      query: query || undefined,
    });
    // One aggregation for this page's links, so every row's traffic comes from the same rows the
    // metrics page reads. Without it this list served `ShareLink.viewCount`, which drifts from the
    // analytics the moment anything reclassifies a row. Scoped to this page's shareIds, not the
    // whole document — the whole point of paginating is that this stays small as links grow.
    const stats = await shareLinkStatsByShareId(docObjectId, links.map((l) => l.shareId));
    return applyTempUserHeaders(
      NextResponse.json(
        { total, page, limit, links: links.map((l) => toShareLinkDTO(l, stats.get(l.shareId) ?? null)) },
        { headers: { "cache-control": "no-store" } },
      ),
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
    // The queue is a gate on the API, not a redirect on one page layout. `(app)/layout.tsx` sent a
    // queued account to /waitlist, which is a decoration: the browser could still call this route
    // directly, and so could an `lnk_` key. See src/lib/gating/waitlist.ts.
    const queued = await forbidWaitlisted(actor, "share a document");
    if (queued) return queued;
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
    if (!link) {
      return applyTempUserHeaders(
        planLimitResponse(limit as Parameters<typeof planLimitResponse>[0], {
          orgId: actor.orgId,
          userId: actor.userId,
          actorKind: actor.kind,
          docId: docObjectId,
          request,
        }),
        actor,
      );
    }

    // Recomputed traffic, like the list route: a response that returns the stored counters made
    // `update_share_link` and `list_share_links` disagree about the same link in the same session.
    const dto = toShareLinkDTO(link, (await shareLinkStatsByShareId(docObjectId)).get(link.shareId) ?? null);
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
    // Slack hears about the new link after the response; `enqueueSlackPosts` never throws.
    after(async () => {
      await enqueueSlackPosts({
        orgId: String(orgId),
        kind: "docUpdates",
        sourceId: `link:${String(link._id)}`,
        event: { docId: docObjectId, projectId: null, shareId: link.shareId, linkId: String(link._id), change: "link_created" },
      });
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
