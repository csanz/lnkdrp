/**
 * `POST /api/oauth/revoke` — token revocation (RFC 7009).
 *
 * A client that is told to forget lnkdrp ("remove server", "disconnect") calls this with either
 * of its tokens; the grant behind them is revoked and the next request with either token fails.
 * The RFC wants 200 whether or not the token was known, so a client cannot probe for tokens; the
 * only 4xx is a client that cannot identify itself.
 */
import { NextResponse } from "next/server";

import { authenticateClient, revokeGrantByToken } from "@/lib/agents/oauth";
import { OAUTH_JSON_HEADERS, clientCredentialsFrom, oauthError, oauthOptions, readOAuthBody } from "@/lib/agents/oauthHttp";
import { errorJson } from "@/lib/http/errorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return oauthOptions();
}

export async function POST(request: Request) {
  try {
    const body = await readOAuthBody(request);
    const { clientId, clientSecret } = clientCredentialsFrom(request, body);
    if (!clientId) return oauthError(400, "invalid_request", "client_id is required.");
    const client = await authenticateClient(clientId, clientSecret);
    if (!client) return oauthError(401, "invalid_client", "Unknown client, or the client secret is wrong.");
    if (typeof body.token !== "string" || !body.token) return oauthError(400, "invalid_request", "token is required.");
    await revokeGrantByToken({ token: body.token, clientId: client.clientId });
    return new NextResponse(null, { status: 200, headers: OAUTH_JSON_HEADERS });
  } catch (err) {
    return errorJson(err, { status: 500, publicMessage: "server_error", context: "[api/oauth/revoke] POST failed" });
  }
}
