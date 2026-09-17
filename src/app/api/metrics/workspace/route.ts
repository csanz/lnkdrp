/**
 * Workspace metrics API — the whole `/metrics` page in one response.
 * Route: `GET /api/metrics/workspace?range=7d|30d|90d` (default `30d`, `?fresh=1` skips the cache).
 *
 * The page asks one question ("how is my sharing doing this month"), so it makes one request: the
 * headline figures with their previous-period comparison, the day series behind them, the ranked
 * documents, links and people, the quiet documents and the workspace's own output.
 *
 * Two things this route decides, and `src/lib/analytics/workspace/query.ts` then obeys:
 * - **The plan.** Free is clamped to `FREE_ANALYTICS_DAYS` silently (`range.clampedByPlan` says so,
 *   and the client snaps its control and offers the upgrade), the same shape every other analytics
 *   route uses. Never a 402: a plan limit must not leave the page blank.
 * - **Identities are withheld, not hidden.** On Free the identity aggregate is never run, so no name
 *   or email is read from Mongo, let alone serialized ([[viewer identity gate]]).
 *
 * Definitions come from the document metrics route by construction — the same expressions, matched
 * by `orgId` instead of `docId`. A document's row here equals its own metrics page for the same
 * range; tests/lib/workspaceMetricsReconcile.test.ts checks that against the live seed corpus.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { loadWorkspaceMetrics } from "@/lib/analytics/workspace/query";
import { parseWorkspaceRangeKey } from "@/lib/analytics/workspace/range";
import type { WorkspaceMetricsResponse } from "@/lib/analytics/workspace/types";
import { getWorkspacePlan, type PlanId } from "@/lib/billing/planLimits";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { resolveActorForStats, tryResolveUserActorFast } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Short-lived server-side cache. The page refetches on the realtime activity frame, and a workspace
 * with several tabs open would otherwise re-run the whole aggregation for each of them.
 *
 * The key carries the plan as well as the workspace and range: a payload built for Free carries no
 * identities, so serving it to the same workspace a minute after it upgraded (or the reverse, which
 * would leak names) must be impossible. Bounded LRU, like `/api/billing/usage`.
 */
const WORKSPACE_METRICS_CACHE_TTL_MS = 60_000;
const WORKSPACE_METRICS_CACHE_MAX = 200;
const workspaceMetricsCache = new Map<string, { at: number; payload: WorkspaceMetricsResponse }>();

/** A payload still inside its TTL, or `null`; touching it also marks it most recently used. */
function cacheGet(key: string): WorkspaceMetricsResponse | null {
  const hit = workspaceMetricsCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at >= WORKSPACE_METRICS_CACHE_TTL_MS) {
    workspaceMetricsCache.delete(key);
    return null;
  }
  // Touch: delete + set moves the entry to the end, so eviction drops the least recently used.
  workspaceMetricsCache.delete(key);
  workspaceMetricsCache.set(key, hit);
  return hit.payload;
}

/** Store a payload and evict the least recently used entries past the cap. */
function cacheSet(key: string, payload: WorkspaceMetricsResponse): void {
  workspaceMetricsCache.delete(key);
  workspaceMetricsCache.set(key, { at: Date.now(), payload });
  while (workspaceMetricsCache.size > WORKSPACE_METRICS_CACHE_MAX) {
    const oldest = workspaceMetricsCache.keys().next();
    if (oldest.done) break;
    workspaceMetricsCache.delete(oldest.value);
  }
}

/**
 * Handle GET requests.
 */
export async function GET(request: Request) {
  return withMongoRequestLogging(request, async () => {
    try {
      // Org context: the active-org cookie / JWT claim, but only after a (cached) membership check,
      // falling back to the full resolver. A temp actor has no workspace to report on, so it is a
      // 401 rather than an empty page — the same rule the rest of the owner analytics follows.
      const actor = (await tryResolveUserActorFast(request)) ?? (await resolveActorForStats(request));
      if (actor.kind !== "user") {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });
      }
      if (!Types.ObjectId.isValid(actor.orgId)) {
        return NextResponse.json({ error: "Invalid org" }, { status: 400, headers: { "cache-control": "no-store" } });
      }

      const url = new URL(request.url);
      const requestedRange = parseWorkspaceRangeKey(url.searchParams.get("range"));
      const fresh = url.searchParams.get("fresh") === "1";

      await connectMongo();
      const plan: PlanId = await getWorkspacePlan(actor.orgId);

      const cacheKey = `${actor.orgId}:${requestedRange}:${plan}`;
      if (!fresh) {
        const cached = cacheGet(cacheKey);
        // `no-store` to the browser either way: the 60 seconds are a server-side shield, not a
        // licence for a proxy or a back button to show yesterday's numbers.
        if (cached) return NextResponse.json(cached, { headers: { "cache-control": "no-store" } });
      }

      const payload = await loadWorkspaceMetrics({ orgId: actor.orgId, plan, requestedRange });
      cacheSet(cacheKey, payload);
      return NextResponse.json(payload, { headers: { "cache-control": "no-store" } });
    } catch (e) {
      // 500 with a fixed sentence, never the driver's own text. A Mongo connection failure or a
      // `$facet` memory-limit error is not a bad request: answering 400 made every outage look like
      // a malformed `?range=` to monitoring (and `parseWorkspaceRangeKey` cannot reject one anyway),
      // and the page rendered the exception message verbatim in its error alert. The 400s above are
      // the two things this route actually validates.
      console.error("[metrics/workspace] failed", e);
      return NextResponse.json(
        { error: "Failed to load workspace metrics." },
        { status: 500, headers: { "cache-control": "no-store" } },
      );
    }
  });
}
