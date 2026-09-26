/**
 * `lnkdrp_whoami` — who the API key acts as, for which workspace, on which plan.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// The schedule is pure (no server-only deps), so the MCP build imports the app's source of truth
// instead of copying the numbers. The Dockerfile copies this file (and its types) into the image.
import { creditsForRun } from "../../../src/lib/credits/schedule";
import type { ActionType, QualityTier } from "../../../src/lib/credits/types";
import { MCP_SERVER_VERSION } from "../config";
import type { PlanSnapshotLite } from "../api";
import type { ToolContext } from "../context";
import { handleTool } from "../errors";
import { SAFETY_TAIL } from "./shared";

/** Every quality level the product has. A cost row names the subset it actually offers. */
export const COST_TIERS: readonly QualityTier[] = ["basic", "standard", "advanced"];

/**
 * One advertised price, shaped so an agent can tell a choice from a fixed price.
 *
 * The same distinction the app's cost catalog draws (`src/lib/credits/costCatalog.ts`: a row
 * declares the `levels` a person can pick, and an empty list means one price and nothing to
 * choose). It is carried in the data here, not only in the prose, because the prose is the half a
 * machine skips: `costs.summary` used to be `[1, 2, 5]` indexed by `costTiers`, which is a price
 * list for three orderable things, and only one of them can be ordered.
 */
export type AdvertisedCost = {
  /** Levels a caller can actually pick for this action. Empty means there is nothing to choose. */
  levels: readonly QualityTier[];
  /**
   * Credits at each level. Always populated for all three, so a reader that ignores `levels` still
   * gets a true number rather than an index error; when `levels` is empty all three are the price
   * that is really charged.
   */
  perLevel: Record<QualityTier, number>;
  /** The one price when `levels` is empty; `null` when the price depends on the level picked. */
  credits: number | null;
};

/** A price row for an action whose level a person really can pick, straight from `creditsForRun`. */
function pickableCost(actionType: ActionType): AdvertisedCost {
  return {
    levels: [...COST_TIERS],
    perLevel: {
      basic: creditsForRun({ actionType, qualityTier: "basic" }),
      standard: creditsForRun({ actionType, qualityTier: "standard" }),
      advanced: creditsForRun({ actionType, qualityTier: "advanced" }),
    },
    credits: null,
  };
}

/**
 * A price row for an action the product only ever runs at one level: the tier every code path pins
 * it to, repeated across `perLevel` so every lookup returns the price that is really charged.
 */
function fixedCost(actionType: ActionType, qualityTier: QualityTier): AdvertisedCost {
  const credits = creditsForRun({ actionType, qualityTier });
  return { levels: [], perLevel: { basic: credits, standard: credits, advanced: credits }, credits };
}

/**
 * The credit price list `lnkdrp_whoami` advertises, action by action.
 *
 * `compare` is the `history` action and `brief` the visit brief. Only `compare` offers a level:
 * the automatic summary is pinned to basic by every path that runs it (the upload process route's
 * `summaryTier`, and the manual rewrite route, which takes no level from its caller), and a brief
 * is one flat price at every tier. `tests/lib/mcpWhoamiCostsCatalog.test.ts` holds this equal to
 * `COST_CATALOG`, the app's own answer to the same question, so the two surfaces that explain
 * lnkdrp's AI prices cannot come apart again.
 */
export function creditCosts(): { summary: AdvertisedCost; compare: AdvertisedCost; brief: AdvertisedCost } {
  return {
    summary: fixedCost("summary", "basic"),
    compare: pickableCost("history"),
    brief: fixedCost("brief", "basic"),
  };
}

/**
 * The automatic summary's price, for the tool description's own prose.
 *
 * Read from the same schedule the payload quotes rather than typed into the sentence: an agent
 * budgets a call from this description, so a number written out here is a price quote and has to
 * stay one. It is the basic price because basic is the only price a summary can be run at.
 */
const SUMMARY_CREDITS = creditCosts().summary.perLevel.basic;

/** One product surface no tool covers yet — named so an agent learns it exists at all. */
type UncoveredFeature = { feature: string; reason: string };

/**
 * What this workspace can and cannot do, in one place — mt_1mVhlEPXGT. Before this, the only way
 * to learn a gate existed was to call a write tool and read the `plan_limit` it happened to throw:
 * true, but only after the fact, per tool, and only for the handful of gates that tool's own code
 * path hits. This answers the question up front, and — the other half of the gap — names product
 * surfaces (requests, download-access requests) that have no MCP tool at all, so "no tool for X"
 * reads as "not built yet" rather than being indistinguishable from "X doesn't exist" or a
 * silently-failed attempt. Project management left this list when `tools/projects.ts` shipped.
 */
function buildCapabilities(
  plan: PlanSnapshotLite | null,
  featureRequestsEnabled: boolean,
): Record<string, unknown> {
  const isPro = plan?.plan === "pro";
  const limits = plan?.limits ?? { documents: null, projects: null, analyticsDays: null, collaborators: null };
  const usage = plan?.usage ?? { documents: 0, projects: 0, members: 0 };
  const remaining = (limit: number | null, used: number) => (limit === null ? null : Math.max(0, limit - used));
  /**
   * Grace beats arithmetic.
   *
   * A Free workspace over its cap but inside the unblocked launch window is not capped — `checkLimit`
   * returns ok with a warning, and `/api/plan` forces every `atLimit` flag false to match. This
   * builder computed `max(0, limit - used)` = 0 and the description tells the agent to read that as
   * "what I can do before attempting anything", so the one preflight it is told to run concluded
   * "upgrade first" during the single window where no upgrade is needed.
   */
  const graceActive = plan?.graceActive === true;
  const atLimit = plan?.atLimit ?? { documents: false, projects: false, collaborators: false };
  const notMcpAccessible: UncoveredFeature[] = [
    {
      feature: "requestRepos",
      reason: featureRequestsEnabled
        ? "exists on this deployment (upload requests, review) but no MCP tool covers it yet"
        : "disabled on this deployment by NEXT_PUBLIC_FEATURE_REQUESTS, so the web app hides it too",
    },
    { feature: "downloadAccessRequests", reason: "no MCP tool, and the app itself has no read endpoint for these yet" },
  ];
  return {
    // Links are never capped on any plan — stated here, not just in tool descriptions, so a plan
    // read alone answers "can I add another link" without needing to try one and see.
    links: { limited: false },
    // Project links are the one link-create a plan can refuse (docs/prds/lnkdrp-project-links.md
    // decision 7). Stated here so an agent learns the gate before it tries, rather than from the
    // plan_limit a create happens to throw: `available: false` means the project's single default
    // link is all this workspace gets.
    projectLinks: { proOnly: true, available: isPro },
    documents: plan
      ? { limit: limits.documents, used: usage.documents, remaining: remaining(limits.documents, usage.documents), atLimit: atLimit.documents }
      : null,
    projects: plan
      ? { limit: limits.projects, used: usage.projects, remaining: remaining(limits.projects, usage.projects), atLimit: atLimit.projects }
      : null,
    // `used` in the collaborators' own unit, which excludes the owner — checkLimit counts them as
    // `members - 1`. Reporting raw members against a collaborator limit put two different units in
    // one object: a Free workspace with nobody invited read `{ limit: 0, used: 1 }`, which says the
    // workspace is one over a cap it is exactly at.
    collaborators: plan
      ? { limit: limits.collaborators, used: Math.max(0, usage.members - 1), members: usage.members, atLimit: atLimit.collaborators }
      : null,
    // Present only while it is true, and worth saying out loud: it is the one state where
    // `remaining: 0` does not mean the next write is refused.
    ...(graceActive ? { graceActive: true as const } : {}),
    // `null` = no cap (Pro); a number is how many days of history `lnkdrp_get_share_stats` serves.
    analyticsDaysLimit: plan ? limits.analyticsDays : null,
    // Viewer identities, per-page time and visit history in lnkdrp_get_share_stats — Pro only, and
    // unrelated to on-demand credits (see whoami.onDemand), which are also Pro-only.
    deepAnalytics: isPro,
    // Whether `allowRevisionHistory: true` (settable on every plan via create/update_share_link)
    // actually lets a recipient browse prior versions once they open the link. The setting itself
    // has no plan gate; only the recipient-facing effect does.
    recipientsCanBrowseVersions: isPro,
    notMcpAccessible,
  };
}

/** Register `lnkdrp_whoami`. */
/**
 * The whoami answer, built once.
 *
 * Exported because the `lnkdrp://workspace` resource used to build its own — it returned
 * `api.whoami()` raw, eleven of nineteen fields, missing credits, capabilities, costs and the
 * version, while describing itself as "whoami JSON". Every field it did return matched, so it read
 * as complete rather than as a subset, and an agent that took the resource instead of the tool
 * could not see the plan limits it was about to hit. One builder is the only way two surfaces
 * claiming to be the same answer stay the same answer.
 */
export async function buildWhoamiPayload(ctx: ToolContext): Promise<Record<string, unknown>> {
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
    capabilities: buildCapabilities(plan, ctx.config.featureRequestsEnabled),
    // The levels that exist in the product, not the levels any given action offers: each row of
    // `costs` carries its own `levels`, and for two of the three that list is empty.
    costTiers: [...COST_TIERS],
    costs: creditCosts(),
    mcpVersion: MCP_SERVER_VERSION,
  };
}

export function registerWhoamiTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_whoami",
    {
      title: "Who am I (lnkdrp)",
      description:
        "Verify the lnkdrp API key and return the workspace it acts on: userId, email, orgId, orgName, plan, key prefix, " +
        "scopes and the client name lnkdrp recorded for this connection, plus the credit cost table, creditsRemaining " +
        "and creditsResetAt when readable, onDemand, capabilities, and the MCP server version. " +
        "costs prices three AI actions, and each row says whether there is anything to pick: levels is the quality " +
        "levels you can actually order for that action and is empty when there are none, perLevel gives the credits at " +
        "each level, and credits is the single price when levels is empty (null when it depends on the level). " +
        "costs is a price list, not a prediction. summary and brief have no level to pick: the summary that runs " +
        `automatically on every upload and replacement is always billed at basic (${SUMMARY_CREDITS} credit) whatever ` +
        "the workspace's review tier says, and nothing in the product can order a dearer one; a visit brief is one " +
        "flat price at every level too. compare is the only row with a choice, and a replacement's compare follows " +
        "the workspace's own history tier, which whoami does not report. So a replacement whose text changed costs " +
        "costs.summary.credits + costs.compare.perLevel[that tier], and one whose text is identical costs nothing at " +
        "all - the compare is skipped and the previous summary kept, which is what unchangedFromPrevious reports. " +
        "costTiers lists the levels that exist in the product; read a row's own levels for what can be picked on it. " +
        "creditsRemaining is credits the workspace holds (included, starter and purchased). " +
        "onDemand: true (Pro only) means AI runs keep going after creditsRemaining reaches 0, billed per credit up to " +
        "the workspace's spend limit, so 0 credits on Pro with onDemand is not a wall. Free workspaces add credits by " +
        "buying packs, which only a person can do. capabilities answers 'what can I do here' in one call, " +
        "before attempting anything: documents/projects (limit, used, remaining; limit null = unlimited - documents.used " +
        "counts shared documents, those with a link on, so it can be lower than lnkdrp_list_docs's total; read atLimit " +
        "rather than remaining to decide whether the next write is refused - a Free workspace inside its launch grace " +
        "window reports capabilities.graceActive: true, remaining 0 and atLimit false, and the write goes through), links " +
        "(never limited on any plan), projectLinks (Pro only - on Free a project keeps its one default link and " +
        "lnkdrp_create_project_link fails with plan_limit), collaborators, analyticsDaysLimit (the window lnkdrp_get_share_stats serves), " +
        "deepAnalytics and recipientsCanBrowseVersions (both Pro-only), and notMcpAccessible - real product features " +
        "(request repos, download-access requests) that have no MCP tool at all, so their absence " +
        "from the tool list reads as 'not built yet', not 'this workspace lacks it' or a silently unsupported request. " +
        "Call this first to confirm the connection works. " +
        SAFETY_TAIL,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async () => buildWhoamiPayload(ctx)),
  );
}
