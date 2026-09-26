/**
 * `GET /api/activity/actor` - the header of one contributor's page.
 *
 * It sits beside `/api/activity` rather than under `/api/people` because it is the same record
 * asked a different way: the feed lists a contributor's rows, this counts them. Both narrow with
 * `buildActorFilter`, so "94 actions" in the header and the rows underneath it are the same query
 * and cannot drift apart.
 *
 * **Why there is no plan check here.** Member identities are already on Free everywhere they
 * appear (the activity feed, the metrics contributors card, a document's contributor card), and no
 * recipient data can reach this endpoint: `buildActorFilter`'s person branch excludes viewer and
 * secret rows by construction, and nothing here reads `meta.viewerName`, `meta.viewerEmail` or
 * `meta.viewerKey`. Gating it would hide a member's own work from their own workspace while the
 * same names stayed visible one screen away.
 *
 * **Why a 404 rather than an empty profile.** `loadActorProfile` returns null when the contributor
 * has no rows in this org, and that emptiness is the tenancy check: without it, `/people/<any 24
 * hex>` would render a blank but real page for a member of somebody else's workspace, which is a
 * membership oracle. So "no rows here" and "not a contributor here" are deliberately the same
 * answer.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { requireOrgRole } from "@/lib/orgs/requireOrgRole";
import { errorJson } from "@/lib/http/errorResponse";
import { parseContributorKey } from "@/lib/people/contributorKey";
import { loadActorProfile } from "@/lib/people/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The 404 body, one string so the route and its test cannot disagree about the wording. */
const NOT_FOUND = "No activity for this actor in this workspace.";

/**
 * `GET /api/activity/actor?key=<ContributorKey>`
 *
 * Answers `200 ActorProfile` (`src/lib/people/types.ts`), `400` for a key that is not one, `403`
 * for a caller who is not a member of the active workspace, `404` when this workspace has nothing
 * by this contributor. Temp users get the 404 too: they have no workspace history to be a
 * contributor in, and 401 would make the app shell's probe look like a bug. `no-store`, read-only.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    // Parsed before anything else is asked: a malformed key is a client bug, it costs nothing to
    // say so, and it says nothing about who exists in which workspace.
    const key = parseContributorKey(url.searchParams.get("key") ?? "");
    if (!key) {
      return NextResponse.json(
        { error: "Invalid key. Pass user:<userId> or agent:<client>@<ownerUserId>." },
        { status: 400 },
      );
    }

    const actor = await resolveActor(request);
    if (actor.kind !== "user") {
      return applyTempUserHeaders(
        NextResponse.json({ error: NOT_FOUND }, { status: 404, headers: { "cache-control": "no-store" } }),
        actor,
      );
    }

    const roleCheck = await requireOrgRole({ orgId: actor.orgId, userId: actor.userId, minRole: "viewer" });
    if (!roleCheck.ok) {
      return NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status });
    }

    await connectMongo();
    const profile = await loadActorProfile({ orgId: new Types.ObjectId(actor.orgId), key });
    if (!profile) {
      return NextResponse.json({ error: NOT_FOUND }, { status: 404, headers: { "cache-control": "no-store" } });
    }

    return NextResponse.json(profile, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return errorJson(err, {
      status: 500,
      publicMessage: "Could not load this contributor",
      context: "[api/activity/actor] GET failed",
    });
  }
}
