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

/**
 * Short-lived in-memory credits snapshot cache.
 *
 * Exists to keep header/usage UI feeling instant by de-duping repeat reads.
 * Assumptions: keyed by workspace (orgId) and `fast` mode; does not change server-of-truth.
 */
const CREDITS_SNAPSHOT_CACHE_TTL_MS = 10_000;
let creditsSnapshotCache: Map<string, { at: number; payload: any }> | null = null;

/**
 * `GET /api/credits/snapshot`
 *
 * Returns the active workspace's credits snapshot (optionally `fast=1`), used by dashboard/header.
 * Side effects: populates a short-lived in-memory cache; never persists/updates billing state.
 * Errors: 401 for unauthenticated, 400 for invalid org or snapshot load failures.
 */
export async function GET(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActorForStats(request);
    try {
      if (actor.kind !== "user") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      if (!Types.ObjectId.isValid(actor.orgId)) return NextResponse.json({ error: "Invalid org" }, { status: 400 });

      const url = new URL(request.url);
      const fast = url.searchParams.get("fast") === "1";
      // Allows the client to explicitly bypass the short-lived in-memory cache after mutations
      // (e.g. updating spend limits) so header values update immediately.
      const bust = url.searchParams.get("bust") === "1";
      const cacheKey = `${String(actor.orgId)}:${fast ? "fast" : "full"}`;
      creditsSnapshotCache = creditsSnapshotCache ?? new Map();
      const cached = creditsSnapshotCache.get(cacheKey);
      if (!bust && cached && Date.now() - cached.at < CREDITS_SNAPSHOT_CACHE_TTL_MS) {
        return NextResponse.json(cached.payload, { headers: { "cache-control": "no-store" } });
      }

      const snap = await getCreditsSnapshot({ workspaceId: actor.orgId, fast });
      creditsSnapshotCache.set(cacheKey, { at: Date.now(), payload: snap });
      if (creditsSnapshotCache.size > 100) {
        let oldestKey: string | null = null;
        let oldestAt = Infinity;
        for (const [k, v] of creditsSnapshotCache.entries()) {
          if (v.at < oldestAt) {
            oldestAt = v.at;
            oldestKey = k;
          }
        }
        if (oldestKey) creditsSnapshotCache.delete(oldestKey);
      }

      return NextResponse.json(snap, { headers: { "cache-control": "no-store" } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load credits";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
  });
}


