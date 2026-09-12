/**
 * `GET /api/plan` — the active workspace's plan, limits, usage and grace state in one cheap call.
 *
 * Powers proactive upsells in the UI (sidebar meter, upload page banner, Teams tab, dashboard)
 * so Free workspaces see where they stand before they hit a wall. Three `countDocuments` plus
 * the subscription lookup; safe to poll on navigation.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { resolveActorForStats } from "@/lib/gating/actor";
import { getWorkspaceGrace, getWorkspacePlan, getWorkspaceUsage, limitsForPlan } from "@/lib/billing/planLimits";
import { errorJson } from "@/lib/http/errorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Plan snapshot for the active workspace (see module doc for the body shape). */
export async function GET(request: Request) {
  try {
    const actor = await resolveActorForStats(request);
    if (!Types.ObjectId.isValid(actor.orgId)) return NextResponse.json({ error: "Invalid org" }, { status: 400 });
    await connectMongo();
    const orgId = actor.orgId;
    const [plan, usage, grace] = await Promise.all([getWorkspacePlan(orgId), getWorkspaceUsage(orgId), getWorkspaceGrace(orgId)]);
    const limits = limitsForPlan(plan);
    const pct = (used: number, max: number | null) => (max === null || max <= 0 ? 0 : Math.min(1, used / max));
    // Mirror `checkLimit`: a Free workspace inside its unblocked launch grace window is not blocked,
    // so `atLimit` must not hard-disable UI the server would still accept.
    const graceActive = plan === "free" && Boolean(grace && !grace.blockedAt && Date.now() < Date.parse(grace.endsAt));
    return NextResponse.json(
      {
        plan,
        orgId,
        isPersonalOrg: actor.orgId === actor.personalOrgId,
        limits,
        usage,
        grace,
        graceActive,
        atLimit: {
          activeLinks: !graceActive && limits.activeLinks !== null && usage.activeLinks >= limits.activeLinks,
          projects: !graceActive && limits.projects !== null && usage.projects >= limits.projects,
          collaborators: !graceActive && Math.max(0, usage.members - 1) >= limits.collaborators,
        },
        fraction: {
          activeLinks: pct(usage.activeLinks, limits.activeLinks),
          projects: pct(usage.projects, limits.projects),
        },
        upgradeUrl: "/pricing",
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return errorJson(err, { status: 500, publicMessage: "Could not load plan" });
  }
}
