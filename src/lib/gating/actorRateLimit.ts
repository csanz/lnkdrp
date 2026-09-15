/**
 * Ceilings on the two ways a caller can spend this app's resources without a signed-in session.
 *
 * 1. **Minting a temp workspace.** Almost any API call from an anonymous caller creates a temp
 *    user, a personal org and a membership, and that identity can then upload a document with
 *    three versions — Blob storage, and OpenAI through starter credits. Nothing ever collected
 *    them. The limit is per client IP and counts only *creation*: a caller that keeps sending the
 *    temp-user headers it was given is never charged again, so a real visitor pays once.
 *
 * 2. **Driving the REST API with an API key.** Agents reach the API through the MCP server, which
 *    proxies every workspace's calls from one Fly egress address, so an IP limit would punish all
 *    of them for one runaway loop. The unit has to be the key.
 *
 * This is the floor in the app, not the whole answer: the deployment runbook also asks for a
 * Vercel Firewall rule on `/api/*`, which refuses abusive traffic before it reaches a function and
 * before it costs anything. Keep both.
 *
 * Both limits fail open — `rateLimit()` allows the request when Mongo is unreachable — because a
 * limiter outage must not become an app outage.
 */
import { NextResponse } from "next/server";

import { clientIpFromRequest, rateLimit } from "@/lib/http/rateLimit";

/** Temp workspaces one IP may create per window. */
export const TEMP_WORKSPACE_CREATE_LIMIT = readPositiveInt(process.env.TEMP_WORKSPACE_CREATE_LIMIT, 20);
/** Window for `TEMP_WORKSPACE_CREATE_LIMIT`, in milliseconds. */
export const TEMP_WORKSPACE_CREATE_WINDOW_MS = 60 * 60 * 1000;

/** Requests one API key may make per window. */
export const API_KEY_REQUEST_LIMIT = readPositiveInt(process.env.API_KEY_REQUEST_LIMIT, 300);
/** Window for `API_KEY_REQUEST_LIMIT`, in milliseconds. */
export const API_KEY_REQUEST_WINDOW_MS = 60 * 1000;

/** Read a positive integer from an env var, falling back when unset or nonsense. */
function readPositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Thrown when a caller is over one of the ceilings above.
 *
 * Routes that use `errorJson` turn it into a 429 with `Retry-After`; routes with their own catch
 * can call `actorRateLimitResponse(err)` to do the same in one line. Anything that does neither
 * still refuses the work, which is the part that matters.
 */
export class ActorRateLimitError extends Error {
  status: number;
  code: "temp_workspace_rate_limited" | "api_key_rate_limited";
  retryAfterSec: number;
  constructor(code: ActorRateLimitError["code"], message: string, retryAfterSec: number) {
    super(message);
    this.name = "ActorRateLimitError";
    this.code = code;
    this.status = 429;
    this.retryAfterSec = Math.max(1, Math.floor(retryAfterSec));
  }
}

/**
 * Build the 429 for an `ActorRateLimitError`, or `null` for any other error.
 *
 * Returns the error's own `code` rather than prose so an agent can branch on it.
 */
export function actorRateLimitResponse(err: unknown): NextResponse | null {
  if (!(err instanceof ActorRateLimitError)) return null;
  return NextResponse.json(
    { error: err.code, message: err.message, retryAfterSeconds: err.retryAfterSec },
    {
      status: err.status,
      headers: { "retry-after": String(err.retryAfterSec), "cache-control": "no-store" },
    },
  );
}

/**
 * Charge one temp-workspace creation against the caller's IP; throw when the IP is over the limit.
 *
 * Call this immediately before minting, never before checking for an existing identity: charging a
 * caller that already has temp-user headers would throttle a returning visitor for coming back.
 */
export async function guardTempWorkspaceCreation(request: Request): Promise<void> {
  const ip = clientIpFromRequest(request);
  const result = await rateLimit({
    key: `temp-workspace:${ip}`,
    limit: TEMP_WORKSPACE_CREATE_LIMIT,
    windowMs: TEMP_WORKSPACE_CREATE_WINDOW_MS,
  });
  if (result.ok) return;
  throw new ActorRateLimitError(
    "temp_workspace_rate_limited",
    "Too many temporary workspaces from this address. Sign in, or try again later.",
    result.retryAfterSec,
  );
}

/**
 * Per-`Request` memo for {@link guardApiKeyRequest}.
 *
 * `tryResolveApiKeyActor` runs from four resolvers and a single route can reach more than one of
 * them, so without this a key's real ceiling would depend on which resolver combination a route
 * happens to use. Keyed by the `Request` object, which dies with the request.
 */
const CHARGED_KEY_REQUESTS = new WeakMap<Request, Promise<void>>();

/**
 * Charge one request against `keyId`; throw when the key is over the limit.
 *
 * Charged at most once per `Request`, and only for a key that already verified — an invalid token
 * is rejected before it gets here, so nobody can burn a real key's budget by guessing at it.
 */
export async function guardApiKeyRequest(request: Request, keyId: string): Promise<void> {
  const pending = CHARGED_KEY_REQUESTS.get(request);
  if (pending) return await pending;

  const p = (async () => {
    const result = await rateLimit({
      key: `api-key:${keyId}`,
      limit: API_KEY_REQUEST_LIMIT,
      windowMs: API_KEY_REQUEST_WINDOW_MS,
    });
    if (result.ok) return;
    throw new ActorRateLimitError(
      "api_key_rate_limited",
      `This API key is over its limit of ${API_KEY_REQUEST_LIMIT} requests per minute.`,
      result.retryAfterSec,
    );
  })();

  CHARGED_KEY_REQUESTS.set(request, p);
  return await p;
}
