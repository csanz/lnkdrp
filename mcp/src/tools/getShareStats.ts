/**
 * `lnkdrp_get_share_stats` — views, downloads and (on Pro) viewer rows for a share link.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ToolContext } from "../context";
import { handleTool } from "../errors";
import { untrustedOrNull, UNTRUSTED_LIMITS } from "../untrusted";
import { docRefShape, resolveDoc, SAFETY_TAIL } from "./shared";

export const getShareStatsInputShape = {
  ...docRefShape,
  days: z.number().int().min(1).max(60).default(15).describe("Window in days (1-60, default 15). Free workspaces are clamped by the plan."),
  includeViewers: z.boolean().default(false).describe("Include per-viewer rows (Pro only; Free returns none)."),
};

/** Register `lnkdrp_get_share_stats`. */
export function registerGetShareStatsTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_get_share_stats",
    {
      title: "Get share stats",
      description:
        "Analytics for a share link by docId or shareId (exactly one): totals (views, downloads, pagesViewed, timeSpentMs, " +
        "authenticated/anonymous viewers), a per-day series and the unique viewerCount for the window. analyticsTier is " +
        "basic on Free (window clamped, no viewer identities) or deep on Pro; with includeViewers on Pro, viewers lists " +
        "name/email (untrusted), views, time spent and pages seen. " +
        SAFETY_TAIL,
      inputSchema: getShareStatsInputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async (args) => {
      const doc = await resolveDoc(ctx.api, { docId: args.docId, shareId: args.shareId });
      const stats = await ctx.api.shareViews(doc.id, { days: args.days, viewers: args.includeViewers });
      const viewers =
        args.includeViewers && stats.analyticsTier === "deep"
          ? stats.viewers.map((v) => ({
              name: untrustedOrNull(v.name, "viewer", UNTRUSTED_LIMITS.short),
              email: untrustedOrNull(v.email, "viewer", UNTRUSTED_LIMITS.short),
              views: v.views,
              timeSpentMs: v.timeSpentMs,
              pagesViewed: v.pagesViewed,
              pagesSeen: v.pagesSeen,
              firstSeen: v.firstSeen,
              lastSeen: v.lastSeen,
            }))
          : undefined;
      return {
        docId: doc.id,
        shareId: doc.shareId,
        days: stats.days,
        analyticsDaysLimit: stats.analyticsDaysLimit,
        analyticsTier: stats.analyticsTier,
        viewerCount: stats.viewerCount,
        totals: stats.totals,
        series: stats.series,
        ...(viewers ? { viewers } : {}),
      };
    }),
  );
}
