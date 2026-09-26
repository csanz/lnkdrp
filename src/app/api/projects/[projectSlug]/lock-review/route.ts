/**
 * API route for `/api/projects/:idOrSlug/lock-review`: what locking or unlocking this room will do,
 * and the token that confirms it (docs/prds/lnkdrp-locked-projects.md, decision 31).
 *
 * `GET` computes the review; `PATCH /api/projects/:id { visibility }` refuses without the token this
 * returns whenever the room has anything to review. The two halves are separate requests on purpose:
 * the dialog has to show the `/p/:shareId` URL that stays live after a lock, the documents that leave
 * workspace listings, and the people who lose sight of the room, BEFORE the write rather than in a
 * toast after it.
 *
 * Refuses an API key like the rest of the identity surfaces (decision 23), and a request inbox, which
 * can never be locked (decision 10) and would otherwise be handed a review it cannot act on.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { forbidApiKey } from "@/lib/gating/forbidApiKey";
import { authOrRateLimitResponse, errorJson } from "@/lib/http/errorResponse";
import { connectMongo } from "@/lib/mongodb";
import { lockReview, type LockTarget } from "@/lib/projects/lockReview";
import { isLockedProject, isRequestProject, resolveProjectForActor } from "@/lib/projects/resolveProject";
import { lockNotSupportedOnRequestResponse } from "@/lib/projects/lockRefusals";
import { requireOrgRole } from "@/lib/orgs/requireOrgRole";

export const runtime = "nodejs";

export async function GET(request: Request, ctx: { params: Promise<{ projectSlug: string }> }) {
  try {
    const { projectSlug } = await ctx.params;
    const param = decodeURIComponent(projectSlug).trim();
    const actor = await resolveActor(request);
    const keyRefusal = forbidApiKey(actor, "lock or unlock a data room");
    if (keyRefusal) return keyRefusal;
    // The same role the write needs: a review is a dry run of it, and a viewer who cannot lock a room
    // has no reason to be handed the list of people a lock would hide it from.
    const roleCheck = await requireOrgRole({ orgId: actor.orgId, userId: actor.userId, minRole: "member" });
    if (!roleCheck.ok) {
      return applyTempUserHeaders(NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status }), actor);
    }

    await connectMongo();
    const project = await resolveProjectForActor({ actor, param, request });
    if (!project) return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);

    const url = new URL(request.url);
    const requested = (url.searchParams.get("target") ?? "").trim();
    // Default to the direction that makes sense for the room's current state, so a client can ask
    // without restating what it already fetched.
    const target: LockTarget =
      requested === "locked" || requested === "workspace"
        ? requested
        : isLockedProject(project)
          ? "workspace"
          : "locked";

    if (target === "locked" && isRequestProject(project)) {
      return applyTempUserHeaders(lockNotSupportedOnRequestResponse(), actor);
    }

    const review = await lockReview({
      orgId: new Types.ObjectId(actor.orgId),
      actorUserId: actor.userId,
      project,
      target,
    });

    return applyTempUserHeaders(
      NextResponse.json(
        {
          project: {
            id: String(project._id),
            name: project.name ?? "",
            visibility: isLockedProject(project) ? "locked" : "workspace",
          },
          review,
        },
        { headers: { "cache-control": "no-store" } },
      ),
      actor,
    );
  } catch (err) {
    const authOrLimited = authOrRateLimitResponse(err);
    if (authOrLimited) return authOrLimited;
    return errorJson(err, {
      status: 500,
      publicMessage: "Could not work out what locking this data room would do",
      context: "[api/projects/:id/lock-review] GET failed",
    });
  }
}
