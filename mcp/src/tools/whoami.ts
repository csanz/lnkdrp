/**
 * `lnkdrp_whoami` — who the API key acts as, for which workspace, on which plan.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { MCP_SERVER_VERSION } from "../config";
import type { ToolContext } from "../context";
import { handleTool } from "../errors";
import { SAFETY_TAIL } from "./shared";

/** Credit costs by quality level, per the launch pricing model (summary 1/2/5, compare 2/5/12). */
export const COSTS = { summary: [1, 2, 5], compare: [2, 5, 12] } as const;

/** Register `lnkdrp_whoami`. */
export function registerWhoamiTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_whoami",
    {
      title: "Who am I (lnkdrp)",
      description:
        "Verify the lnkdrp API key and return the workspace it acts on: userId, email, orgId, orgName, plan, key prefix, " +
        "scopes and the client name lnkdrp recorded for this connection, plus the credit cost table and the MCP server version. " +
        "Call this first to confirm the connection works. " +
        SAFETY_TAIL,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async () => {
      const whoami = await ctx.api.whoami();
      ctx.setWhoami(whoami);
      return { ...whoami, costs: { summary: [...COSTS.summary], compare: [...COSTS.compare] }, mcpVersion: MCP_SERVER_VERSION };
    }),
  );
}
