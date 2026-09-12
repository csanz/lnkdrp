/**
 * Route-level convenience around `requireOrgRole` for mutating handlers.
 *
 * Org membership is the tenancy boundary; the role is the authorization. Every handler that
 * creates or changes workspace data (docs, uploads, projects, requests, share settings, billed
 * processing) must reject `viewer` members, not only the PATCH/DELETE handlers.
 */
import { NextResponse } from "next/server";
import { applyTempUserHeaders, type Actor } from "@/lib/gating/actor";
import { requireOrgRole, type OrgRole } from "@/lib/orgs/requireOrgRole";

/**
 * Return a ready-to-send 403 response when `actor` holds less than `minRole` in its active org,
 * or `null` when the actor may proceed.
 *
 * Temp users always act inside their own personal workspace (they pass as its owner), so the
 * check is a cheap personal-org lookup for them.
 */
export async function forbidUnlessOrgRole(actor: Actor, minRole: OrgRole = "member"): Promise<Response | null> {
  const check = await requireOrgRole({ orgId: actor.orgId, userId: actor.userId, minRole });
  if (check.ok) return null;
  return applyTempUserHeaders(NextResponse.json({ error: check.error }, { status: check.status }), actor);
}
