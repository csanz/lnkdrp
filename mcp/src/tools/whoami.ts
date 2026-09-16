/**
 * `lnkdrp_whoami` — who the API key acts as, for which workspace, on which plan.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// The schedule is pure (no server-only deps), so the MCP build imports the app's source of truth
// instead of copying the numbers. The Dockerfile copies this file (and its types) into the image.
import { creditsForRun } from "../../../src/lib/credits/schedule";
import type { ActionType, QualityTier } from "../../../src/lib/credits/types";
import { MCP_SERVER_VERSION } from "../config";
import type { ToolContext } from "../context";
import { handleTool } from "../errors";
import { SAFETY_TAIL } from "./shared";

/** Tier order of every cost array: basic, standard, advanced. */
export const COST_TIERS: readonly QualityTier[] = ["basic", "standard", "advanced"];

/** Credits per tier for one action, straight from `creditsForRun`. */
function costsFor(actionType: ActionType): number[] {
  return COST_TIERS.map((qualityTier) => creditsForRun({ actionType, qualityTier }));
}

/** Credit costs by quality tier (basic, standard, advanced); `compare` is the `history` action. */
export function creditCosts(): { summary: number[]; compare: number[] } {
  return { summary: costsFor("summary"), compare: costsFor("history") };
}

/** Register `lnkdrp_whoami`. */
export function registerWhoamiTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_whoami",
    {
      title: "Who am I (lnkdrp)",
      description:
        "Verify the lnkdrp API key and return the workspace it acts on: userId, email, orgId, orgName, plan, key prefix, " +
        "scopes and the client name lnkdrp recorded for this connection, plus the credit cost table (credits per tier " +
        "basic/standard/advanced), creditsRemaining and creditsResetAt when readable, onDemand, and the MCP server " +
        "version. plan: 'free' with onDemand: true means the workspace has added a card for pay-as-you-go - it is not " +
        "on Pro's limits, but it will not simply run out of credits once its one-time starter credits are spent; do not " +
        "read 'free' alone as 'will hit a wall'. Call this first to confirm the connection works. " +
        SAFETY_TAIL,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async () => {
      const whoami = await ctx.api.whoami();
      ctx.setWhoami(whoami);
      // Best-effort: whoami must not fail because the credits or plan snapshot could not be read.
      const [credits, plan] = await Promise.all([
        ctx.api.creditsSnapshot().catch(() => null),
        ctx.api.planSnapshot().catch(() => null),
      ]);
      return {
        ...whoami,
        plan: plan?.plan ?? whoami.plan,
        creditsRemaining: credits?.creditsRemaining ?? null,
        creditsResetAt: credits?.resetAt ?? null,
        // `false` when the snapshot could not be read, same as every other credits field here —
        // a Pro workspace with this false just means the read failed, not that on-demand is off.
        onDemand: credits?.onDemandEnabled ?? false,
        costTiers: [...COST_TIERS],
        costs: creditCosts(),
        mcpVersion: MCP_SERVER_VERSION,
      };
    }),
  );
}
