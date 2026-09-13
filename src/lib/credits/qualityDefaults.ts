/**
 * Workspace-level AI quality-tier defaults.
 *
 * The automatic AI compare (`history`) tier is a plan-aware workspace default: Free runs Basic,
 * Pro runs Standard, and an owner/admin can pin any tier from the dashboard Limits tab
 * (`/api/credits/quality-defaults`). A stored value always wins; `null`/unset means "follow the plan".
 */
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { WorkspaceCreditBalanceModel } from "@/lib/models/WorkspaceCreditBalance";
import { getWorkspacePlan, type PlanId } from "@/lib/billing/planLimits";
import type { QualityTier } from "@/lib/credits/types";

/** Parse an untrusted value into a tier, or null when it is not one. */
export function parseQualityTier(v: unknown): QualityTier | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (s === "basic") return "basic";
  if (s === "standard") return "standard";
  if (s === "advanced") return "advanced";
  return null;
}

/** Plan-aware default for the automatic AI compare: Free → `"basic"`, Pro → `"standard"`. */
export function defaultHistoryQualityTierForPlan(plan: PlanId): QualityTier {
  return plan === "pro" ? "standard" : "basic";
}

/**
 * Effective compare tier given what is stored on the balance row and the workspace plan.
 *
 * Pure so the route and the process path resolve identically: a valid stored tier wins,
 * otherwise the plan default.
 */
export function resolveHistoryQualityTier(stored: unknown, plan: PlanId): QualityTier {
  return parseQualityTier(stored) ?? defaultHistoryQualityTierForPlan(plan);
}

/**
 * Effective compare tier for a workspace: the stored `defaultHistoryQualityTier` when set,
 * otherwise the plan-aware default (`basic` on Free, `standard` on Pro).
 *
 * Errors: throws on a malformed org id; DB failures propagate.
 */
export async function getDefaultHistoryQualityTier(orgId: string | Types.ObjectId): Promise<QualityTier> {
  const id = orgId instanceof Types.ObjectId ? orgId : new Types.ObjectId(String(orgId).trim());
  await connectMongo();
  const [plan, bal] = await Promise.all([
    getWorkspacePlan(id),
    WorkspaceCreditBalanceModel.findOne({ workspaceId: id }).select({ defaultHistoryQualityTier: 1 }).lean(),
  ]);
  return resolveHistoryQualityTier((bal as { defaultHistoryQualityTier?: unknown } | null)?.defaultHistoryQualityTier, plan);
}
