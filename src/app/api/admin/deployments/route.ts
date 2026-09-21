/**
 * Admin API route: `GET /api/admin/deployments`
 *
 * The last N deployments of this project, read from Vercel. Gated by `requireAdmin` like every
 * other `/api/admin/*` route: this is operational detail about the running system, and an API key
 * cannot ask for it.
 *
 * Two things this route deliberately does not do:
 *
 * - **It does not fail.** An unconfigured deployment, a rejected token and a Vercel outage all come
 *   back as a 200 carrying `configured` and `upstream`, because the page's job is to say what is
 *   wrong rather than to show a broken panel. The only non-200 here is the admin gate's own.
 * - **It does not call Vercel on every paint.** The answer is memoised in-process for
 *   `CACHE_TTL_MS`. An admin refreshing a board should not be able to walk the project into
 *   someone else's rate limit.
 */
import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/gating/requireAdmin";
import { listDeployments, vercelConfig, type VercelDeployment, type VercelFailure } from "@/lib/vercel/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * How long an answer is reused.
 *
 * 60 seconds. A build takes minutes, so a minute-old board is still telling the truth about what is
 * happening, and it puts a hard ceiling of one upstream call per minute per running instance
 * however hard the Refresh button is pressed.
 */
const CACHE_TTL_MS = 60_000;

/** Default number of deployments. Enough to see the last day of activity without a wall of rows. */
const DEFAULT_LIMIT = 20;

/** Hard ceiling, matching the client's own cap. */
const MAX_LIMIT = 50;

type Payload = {
  ok: true;
  configured: boolean;
  /** Variable names only, so the page can tell an admin exactly what to set. Never values. */
  missing: string[];
  teamScoped: boolean;
  deployments: VercelDeployment[];
  /** Null when the read succeeded. Otherwise why it did not, in a sentence. */
  upstream: { reason: VercelFailure["reason"]; status: number | null; message: string } | null;
  /** When this answer was actually fetched, so the page can show its age rather than imply "now". */
  fetchedAt: string;
};

/** One entry per limit, because a 50-row ask must not be served the cached 20-row answer. */
const cache = new Map<number, { at: number; payload: Payload }>();

/** The `limit` query parameter, bounded. Anything unreadable falls back to the default. */
function asLimit(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.floor(n)), MAX_LIMIT);
}

/** One fresh answer: the config summary, plus whatever Vercel said, or why it said nothing. */
async function build(limit: number): Promise<Payload> {
  const cfg = vercelConfig();
  const base = {
    ok: true as const,
    configured: cfg.configured,
    missing: cfg.missing,
    teamScoped: cfg.teamScoped,
    fetchedAt: new Date().toISOString(),
  };

  const res = await listDeployments(limit);
  if (!res.ok) {
    return {
      ...base,
      deployments: [],
      upstream: { reason: res.reason, status: res.status ?? null, message: res.message },
    };
  }
  return { ...base, deployments: res.data, upstream: null };
}

/** The deployment board's data. Always a 200 once the caller is an admin. */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const limit = asLimit(new URL(request.url).searchParams.get("limit"));

  const hit = cache.get(limit);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return NextResponse.json({ ...hit.payload, cached: true }, { headers: { "Cache-Control": "private, no-store" } });
  }

  const payload = await build(limit);
  cache.set(limit, { at: now, payload });
  return NextResponse.json({ ...payload, cached: false }, { headers: { "Cache-Control": "private, no-store" } });
}
