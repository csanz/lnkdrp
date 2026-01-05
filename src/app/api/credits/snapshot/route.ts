/**
 * API route for `/api/credits/snapshot`.
 *
 * Returns a single credits snapshot for the active workspace. Customer-facing:
 * - includes credits + cycle boundaries
 * - never includes model names, tokens, or raw cost
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { resolveActorForStats } from "@/lib/gating/actor";
import { getCreditsSnapshot } from "@/lib/credits/snapshot";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActorForStats(request);
    try {
      if (actor.kind !== "user") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      if (!Types.ObjectId.isValid(actor.orgId)) return NextResponse.json({ error: "Invalid org" }, { status: 400 });

      const snap = await getCreditsSnapshot({ workspaceId: actor.orgId });
      return NextResponse.json(snap, { headers: { "cache-control": "no-store" } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load credits";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
  });
}


