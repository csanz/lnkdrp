/**
 * `POST /api/oauth/token` — the token endpoint (RFC 6749 §4.1.3, §6; PKCE per RFC 7636).
 *
 * Two grant types:
 * - `authorization_code`: the code from the consent redirect plus the client's `code_verifier`
 *   and the same `redirect_uri`. Every check lives in `spendAuthorizationCode`.
 * - `refresh_token`: rotates both tokens on the same grant.
 *
 * The client identifies itself by `client_id` (body or HTTP Basic); a confidential client also
 * presents its secret. Answers are `{ access_token, token_type, expires_in, refresh_token, scope }`
 * with `Cache-Control: no-store`, or a §5.2 error. Errors say what is wrong in a sentence, because
 * the person reading them is at a terminal watching a client fail to connect.
 */
import { NextResponse } from "next/server";

import { authenticateClient, refreshGrant, spendAuthorizationCode } from "@/lib/agents/oauth";
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
    if (!client) return oauthError(401, "invalid_client", "Unknown client, or the client secret is wrong. Register the client again.");

    const grantType = body.grant_type;
    if (grantType === "authorization_code") {
      const result = await spendAuthorizationCode({
        code: body.code,
        clientId: client.clientId,
        codeVerifier: body.code_verifier,
        redirectUri: body.redirect_uri,
        clientName: client.clientName,
      });
      if (!result.ok) return oauthError(400, result.error, result.description);
      return tokens(result.tokens);
    }
    if (grantType === "refresh_token") {
      const result = await refreshGrant({ refreshToken: body.refresh_token, clientId: client.clientId });
      if (!result.ok) return oauthError(400, result.error, result.description);
      return tokens(result.tokens);
    }
    return oauthError(400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token.");
  } catch (err) {
    return errorJson(err, { status: 500, publicMessage: "server_error", context: "[api/oauth/token] POST failed" });
  }
}

function tokens(t: { accessToken: string; refreshToken: string; expiresIn: number; scopes: string[] }): NextResponse {
  return NextResponse.json(
    { access_token: t.accessToken, token_type: "Bearer", expires_in: t.expiresIn, refresh_token: t.refreshToken, scope: t.scopes.join(" ") },
    { headers: OAUTH_JSON_HEADERS },
  );
}
