/**
 * `POST /api/oauth/register` — dynamic client registration (RFC 7591).
 *
 * Open to anyone, by design: a hosted connector or a CLI on someone's laptop registers itself
 * the first time it meets this server, and no person could pre-create it. What bounds the
 * exposure is that a registered client can do nothing until a signed-in member clicks Allow for
 * it, and that registrations are rate-limited per address. Rows are never deleted; a client's
 * name is what the Connect page shows next to its grants.
 *
 * 201 with the RFC 7591 response (`client_id`, the metadata as accepted, and a `client_secret`
 * only for a client that asked for one). 400 `invalid_client_metadata` / `invalid_redirect_uri`,
 * 429 over the ceiling.
 */
import { NextResponse } from "next/server";

import { OAUTH_REGISTER_LIMIT_PER_HOUR, parseClientRegistration, registerClient } from "@/lib/agents/oauth";
import { OAUTH_JSON_HEADERS, oauthError, oauthOptions } from "@/lib/agents/oauthHttp";
import { clientIpFromRequest, rateLimit } from "@/lib/http/rateLimit";
import { errorJson } from "@/lib/http/errorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return oauthOptions();
}

export async function POST(request: Request) {
  try {
    const ip = clientIpFromRequest(request);
    const limited = await rateLimit({ key: `oauth-register:${ip}`, limit: OAUTH_REGISTER_LIMIT_PER_HOUR, windowMs: 60 * 60 * 1000 });
    if (!limited.ok) {
      return NextResponse.json(
        { error: "invalid_request", error_description: "Too many client registrations from this address. Try again later." },
        { status: 429, headers: { ...OAUTH_JSON_HEADERS, "retry-after": String(limited.retryAfterSec) } },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return oauthError(400, "invalid_client_metadata", "The body must be JSON.");
    }
    const parsed = parseClientRegistration(body);
    if (!parsed.ok) return oauthError(400, parsed.error, parsed.description);

    const { client, clientSecret } = await registerClient({ ...parsed.value, ip });
    return NextResponse.json(
      {
        client_id: client.clientId,
        ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
        client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: client.tokenEndpointAuthMethod,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        ...(client.clientUri ? { client_uri: client.clientUri } : {}),
      },
      { status: 201, headers: OAUTH_JSON_HEADERS },
    );
  } catch (err) {
    return errorJson(err, { status: 500, publicMessage: "server_error", context: "[api/oauth/register] POST failed" });
  }
}
