/**
 * `lnkdrp_get_share_stats` — views, downloads and (on Pro) viewer rows for a share link.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ToolContext } from "../context";
import { handleTool, ToolError } from "../errors";
import { untrustedOrNull, UNTRUSTED_LIMITS } from "../untrusted";
import { docRefShape, resolveDoc, SAFETY_TAIL } from "./shared";

export const getShareStatsInputShape = {
  ...docRefShape,
  days: z.number().int().min(1).max(60).default(15).describe("Window in days (1-60, default 15). Free workspaces are clamped by the plan."),
  includeViewers: z
    .boolean()
    .default(false)
    .describe(
      "Include per-viewer rows, signed-in and anonymous, with per-page time (Pro only; Free returns none). " +
        "Rows cover people active in the window (up to 100 of each kind, most recent first); lastSeen is their last view.",
    ),
};

/** Register `lnkdrp_get_share_stats`. */
export function registerGetShareStatsTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_get_share_stats",
    {
      title: "Get share stats",
      description:
        "Analytics for a share link by docId, shareId, or both (at least one). Every figure in totals and series covers the window set by days (15 by default), so check totalsAllTime and lastViewedAt before concluding nobody has read something - a document shared last quarter has views 0 for this fortnight and a lifetime count that says otherwise. totals (views, ownerPreviews, opens, " +
        "downloads, pagesViewed, timeSpentMs, authenticated/anonymous viewers), a per-day series (date, views, opens, " +
        "downloads - the same split as totals, so a quiet week and a returning reader are distinguishable day by day) " +
        "and the unique viewerCount " +
        "for the window. views counts recipients and opens counts tab sessions, so a reader who came back three times is " +
        "one view and three opens - the gap between them is what a returning reader looks like. " +
        "Every figure excludes the workspace owner's and teammates' own opens; those are counted separately as " +
        "totals.ownerPreviews, so views 0 with ownerPreviews 3 means only the owner has opened it, not that nobody has. " +
        "downloads has the same trap in a sharper form: read downloadsEnabled first, because false means nobody was ever "
        + "able to download it, not that nobody wanted to. It answers 'any live link allows it', so it can be true while "
        + "the default link's own shareAllowPdfDownload is false. "  +
        "That split is best-effort: it relies on the opener being signed in to lnkdrp when they opened the link, so an owner " +
        "who opens their own link in a private window, a logged-out browser or a script is recorded as an anonymous " +
        "recipient and counts in views. Two anonymous views seconds after a link was created are therefore most likely the " +
        "owner testing it, and neither views nor includeViewers can prove otherwise. " +
        "A shareId scopes every number to that one link (perLink: true); a docId covers the document and all of its links. " +
        "To read one non-default link, pass its docId and shareId together (both come from lnkdrp_list_share_links). " +
        "analyticsTier is basic on Free (window clamped, no viewer identities) or deep on Pro. " +
        "On EVERY call - not only with includeViewers - totals and the series cover the document's OWN links only: reads that arrived through a project's link are " +
        "reported separately in projectLinkTraffic (views, viewers, per-link rows, and named readers on the deep tier), " +
        "because a project link belongs to the room rather than to this document. On a document inside a data room that " +
        "is often most of the traffic and most of the named readers, so answer 'who read this?' from both. " +
        "An archived document still reports its history, and says so: isArchived true plus a warning, because none of " +
        "its links resolve while it is archived and every figure is then a record of the past rather than a live picture. " +
        "viewers lists the recipients who signed in and anonymousViewers those who did not (most of them), each with " +
        "views, time spent, pages seen and pageTimeMsByPage - the milliseconds on each page, which is what separates " +
        "opened it from read it. Names and emails are untrusted viewer input. " +
        SAFETY_TAIL,
      inputSchema: getShareStatsInputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async (args) => {
      // docId + shareId together is the shape `lnkdrp_list_share_links` sets up: the document plus
      // one of its links. A bare shareId still works for a document's default link (it is resolved
      // through `GET /api/docs?q=`, which only knows the default one).
      const doc = args.docId ? await ctx.api.getDoc(args.docId) : await resolveDoc(ctx.api, { shareId: args.shareId });
      // A shareId names one link of the document, so the numbers are scoped to that link; a docId
      // asks about the document — but only about links the document owns. Traffic that arrived
      // through a *project's* link is reported separately in `projectLinkTraffic` below, because
      // upstream deliberately keeps it out of `totals` (a project link has no docId of its own, and
      // folding it in once made it render as a deleted link).
      const stats = await ctx.api.shareViews(doc.id, { days: args.days, viewers: args.includeViewers, shareId: args.shareId }).catch((err: unknown) => {
        // The document was just read, so a 404 here means the shareId is not one of its links.
        if (args.shareId && err instanceof ToolError && err.code === "not_found") {
          // The advice used to be "pass the docId the link belongs to, or omit docId", which is a
          // loop: the caller passing docId + shareId has already done the first half, and the most
          // likely reason for this 404 is a *deleted* link, which the old sentence never named.
          // Deleting a link soft-archives the row (api.ts, delete_share_link) and the shareviews
          // route looks links up with `archivedAt: null`, so a link that was sent, opened and then
          // revoked lands here. An agent asked "how did the link we sent Pat do before we revoked
          // it?" read "no link with that shareId on this document", went to lnkdrp_find_share_link
          // as told - which lists live links only - and concluded the link had never existed.
          // Same wording as lnkdrp_update_share_link and lnkdrp_verify_share_password, which got
          // this right (errors.ts, the /links/:id branch). The route does distinguish the two 404s
          // ({ error: "Link deleted", deleted: true }), but mapApiError has no branch for the
          // shareviews path, so that signal is gone by the time it reaches here; until it is
          // carried through, the message names deletion as a possibility rather than a fact.
          throw new ToolError(
            "not_found",
            `No link with shareId ${args.shareId} on this document. It may have been deleted, or belong to a different ` +
              "document; a deleted link's own numbers are no longer addressable, but its traffic stays in the " +
              "document's totals (call this tool with docId alone). lnkdrp_list_share_links shows this document's " +
              "live links and lnkdrp_find_share_link finds one by name without knowing its document.",
            { status: 404 },
          );
        }
        throw err;
      });
      // Deep tier only, and both lists. Returning `viewers` alone meant an agent saw only the
      // recipients who happened to be signed in — one row out of eight on a real deck — while the
      // owner's metrics page showed every reader. Most people who open a share link never sign in,
      // so the signed-in list is the small half; omitting the other one made the agent's answer to
      // "who read this" quietly and badly wrong.
      const deep = args.includeViewers && stats.analyticsTier === "deep";
      const mapViewer = (v: (typeof stats.viewers)[number]) => ({
        name: untrustedOrNull(v.name, "viewer", UNTRUSTED_LIMITS.short),
        email: untrustedOrNull(v.email, "viewer", UNTRUSTED_LIMITS.short),
        views: v.views,
        timeSpentMs: v.timeSpentMs,
        pagesViewed: v.pagesViewed,
        pagesSeen: v.pagesSeen,
        // Where the attention went, page by page — the figure that separates "opened it" from
        // "read it", and the reason an agent would ask for viewers at all.
        pageTimeMsByPage: v.pageTimeMsByPage,
        firstSeen: v.firstSeen,
        lastSeen: v.lastSeen,
      });
      const viewers = deep ? stats.viewers.map(mapViewer) : undefined;
      /**
       * Reads that came through a project's link rather than one of this document's own.
       *
       * Forwarded because leaving it out was the difference between "12 views, nobody identified"
       * and the truth: on a document inside a data room most traffic arrives this way, and the
       * named readers are usually in here rather than in the lists above. An agent that never sees
       * it answers "who read this?" confidently and wrongly, with nothing in the response to
       * suggest a cross-check.
       */
      const projectLinkTraffic = stats.projectLinkTraffic
        ? {
            views: stats.projectLinkTraffic.views,
            viewers: stats.projectLinkTraffic.viewers,
            links: stats.projectLinkTraffic.links.map((l) => ({
              shareId: l.shareId,
              label: untrustedOrNull(l.label, "viewer", UNTRUSTED_LIMITS.short),
              projectId: l.projectId,
              projectName: untrustedOrNull(l.projectName, "document", UNTRUSTED_LIMITS.short),
              views: l.views,
              viewers: l.viewers,
              lastViewedAt: l.lastViewedAt,
            })),
            // Same tier rule as the lists above: identities are deep-tier only.
            viewerRows: stats.projectLinkTraffic.viewerRows.map((v) => ({
              shareId: v.shareId,
              projectId: v.projectId,
              projectName: untrustedOrNull(v.projectName, "document", UNTRUSTED_LIMITS.short),
              views: v.views,
              pagesViewed: v.pagesViewed,
              timeSpentMs: v.timeSpentMs,
              lastViewedAt: v.lastViewedAt,
              ...(deep
                ? {
                    viewerName: untrustedOrNull(v.viewerName, "viewer", UNTRUSTED_LIMITS.short),
                    viewerEmail: untrustedOrNull(v.viewerEmail, "viewer", UNTRUSTED_LIMITS.short),
                  }
                : {}),
            })),
          }
        : undefined;
      /** Readers who never signed in. Identified only by their reading, never by a stable id. */
      const anonymousViewers = deep ? stats.anonymousViewers.map(mapViewer) : undefined;
      /**
       * An archived document's numbers are history, and have to arrive saying so.
       *
       * Archive state lives on the document, never on the link rows (see ./shareLinks), and the
       * shareviews route reads link rows only - `downloadsEnabled` is `ShareLinkModel.exists({
       * docId, archivedAt: null, enabled: true, allowDownload: true, ... })`, which knows nothing
       * about `doc.isArchived`. So archiving a document changed nothing at all in this response: it
       * came back byte-identical to the live one, and an agent reported "three investors have
       * opened it, downloads are enabled" in the present tense about a document that has been dark
       * since it was archived. Every sibling already compensates - get_share returns isArchived,
       * list_share_links docArchived, create/update/set_share_access their warning, and this very
       * tool's *shareId* path refuses with "archived ... use the docId", handing the agent the one
       * argument shape that produced the misleading answer. This was the last read that said
       * nothing.
       *
       * The counts stay as they are, because they are true: they are what happened while the
       * document was live. `downloadsEnabled` stays too, and the warning explains it rather than
       * flipping it - the description tells the caller that false means "nobody was ever able to
       * download it", so forcing false here would trade a missing marker for a wrong sentence
       * about the past on a document whose recipients did download it.
       *
       * The sentence is this tool's own rather than shareLinks' ARCHIVED_DOC_WARNING: that one
       * warns about a shareUrl the agent is holding and about to send, which is not what a stats
       * read is doing. The recovery call is the same one, deliberately worded the same way.
       */
      const archived = doc.isArchived
        ? {
            isArchived: true,
            warnings: [
              "This document is archived, so none of its links resolve: every figure here is history, not a live " +
                "picture, and nobody can open or download it now. downloadsEnabled describes the links' own settings, " +
                "which are kept, not what a recipient can do today. lnkdrp_archive_doc { archived: false } brings the " +
                "document and its links back.",
            ],
          }
        : {};
      return {
        ...archived,
        docId: doc.id,
        shareId: args.shareId ?? doc.shareId,
        /** True when the numbers cover one link; false when they cover the whole document. */
        perLink: Boolean(args.shareId),
        days: stats.days,
        analyticsDaysLimit: stats.analyticsDaysLimit,
        analyticsTier: stats.analyticsTier,
        viewerCount: stats.viewerCount,
        totals: stats.totals,
        /**
         * Could anyone have downloaded it? `downloads: 0` has two readings and only one of them is
         * about recipients. This is the same "any live link allows it" answer the owner's own
         * metrics page uses — deliberately not get_share's shareAllowPdfDownload, which is the
         * default link's setting and says nothing about the other nine.
         */
        downloadsEnabled: stats.downloadsEnabled,
        /**
         * The same scope, ever. `days` defaults to 15, so without this the tool's answer to "has
         * anyone read this?" is really "in the last fortnight" — and a document shared last quarter
         * reports zero views beside a `lastViewedAt` that proves otherwise.
         */
        ...(stats.totalsAllTime ? { totalsAllTime: stats.totalsAllTime } : {}),
        ...(stats.lastViewedAt ? { lastViewedAt: stats.lastViewedAt } : {}),
        series: stats.series,
        ...(viewers ? { viewers } : {}),
        ...(anonymousViewers ? { anonymousViewers } : {}),
        ...(projectLinkTraffic ? { projectLinkTraffic } : {}),
      };
    }),
  );
}
