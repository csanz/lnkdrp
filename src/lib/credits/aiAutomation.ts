/**
 * Whether a workspace wants the AI runs that start without anyone asking.
 *
 * Two of them exist: the summary written for every upload, and the compare run when a document is
 * replaced. Everything else in the product — review, a compare rerun, a summary written later from
 * the document page — begins with a click, and not clicking is already the off switch. These two do
 * not, so they are the only ones that can spend credits while someone is doing something else, and
 * the only ones that need a setting.
 *
 * That is the whole reason this is two booleans and not a switchboard with a row per feature. A
 * toggle next to "AI review" would imply the feature does something when left on, which it does
 * not; it waits to be asked either way.
 *
 * **Both default on, and an absent field reads as on.** A workspace that never sees a summary has
 * not really seen what a link is worth, so off has to be something a person chose. That also makes
 * the setting safe to add to rows that predate it: `undefined` is not off.
 */
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { WorkspaceCreditBalanceModel } from "@/lib/models/WorkspaceCreditBalance";

/** The automatic runs a workspace has left switched on. */
export type AiAutomation = {
  /** The summary written for every upload. */
  summary: boolean;
  /** The compare run when a document is replaced. */
  compare: boolean;
};

export const AI_AUTOMATION_DEFAULT: AiAutomation = { summary: true, compare: true };

/**
 * Read one stored flag.
 *
 * Only an explicit `false` is off. `undefined` (a row written before the field existed), `null` and
 * anything non-boolean all read as on — the permissive direction on purpose, because the failure
 * this avoids is a workspace that silently stops summarising and looks broken.
 */
export function isAutomationOn(stored: unknown): boolean {
  return stored !== false;
}

/** Turn a balance row (or its absence) into the pair of flags. */
export function resolveAiAutomation(bal: { autoSummaryEnabled?: unknown; autoCompareEnabled?: unknown } | null): AiAutomation {
  return {
    summary: isAutomationOn(bal?.autoSummaryEnabled),
    compare: isAutomationOn(bal?.autoCompareEnabled),
  };
}

/**
 * What this workspace has switched on.
 *
 * One `_id`-keyed read. A missing balance row means the workspace has never run anything, which is
 * both flags on.
 *
 * Errors: throws on a malformed org id; DB failures propagate.
 */
export async function getAiAutomation(orgId: string | Types.ObjectId): Promise<AiAutomation> {
  const id = orgId instanceof Types.ObjectId ? orgId : new Types.ObjectId(String(orgId).trim());
  await connectMongo();
  const bal = await WorkspaceCreditBalanceModel.findOne({ workspaceId: id })
    .select({ autoSummaryEnabled: 1, autoCompareEnabled: 1 })
    .lean();
  return resolveAiAutomation(bal as { autoSummaryEnabled?: unknown; autoCompareEnabled?: unknown } | null);
}

/** Parse an untrusted value into a flag, or `null` when it is not a boolean. */
export function parseAutomationFlag(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  return null;
}
