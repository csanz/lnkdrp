/**
 * The HTTP conventions the OAuth endpoints share (`src/app/api/oauth/**`).
 *
 * OAuth clients speak `application/x-www-form-urlencoded` (RFC 6749 §4.1.3) and some MCP clients
 * send JSON; both are read into one plain object. Client credentials arrive either as HTTP Basic
 * (`client_secret_basic`) or in the body (`client_secret_post`); a public client sends only its
 * id. Errors are the RFC 6749 §5.2 shape, `{ error, error_description }`, never a redirect: these
 * endpoints are called by the client, not the browser.
 *
 * CORS is wide open on these three endpoints and the metadata document. They hold no session,
 * every response is either public metadata or bound to a secret the caller had to present, and
 * a browser-based MCP client cannot reach them otherwise. The `/mcp` endpoint itself is a
 * different matter and is not touched here.
 */
import { NextResponse } from "next/server";

export const OAUTH_CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-max-age": "86400",
} as const;

export const OAUTH_JSON_HEADERS = { "cache-control": "no-store", pragma: "no-cache", ...OAUTH_CORS_HEADERS } as const;

/** Preflight answer for every OAuth endpoint. */
export function oauthOptions(): NextResponse {
  return new NextResponse(null, { status: 204, headers: OAUTH_CORS_HEADERS });
}

export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "invalid_client_metadata"
  | "invalid_redirect_uri"
  | "server_error";

/** RFC 6749 §5.2 error body. `invalid_client` carries the `WWW-Authenticate` the RFC asks for. */
export function oauthError(status: number, error: OAuthErrorCode, description: string): NextResponse {
  const headers: Record<string, string> = { ...OAUTH_JSON_HEADERS };
  if (error === "invalid_client") headers["www-authenticate"] = 'Basic realm="lnkdrp", charset="UTF-8"';
  return NextResponse.json({ error, error_description: description }, { status, headers });
}

/** The request body as one string-valued object, from a form or from JSON. Unknown types read as empty. */
export async function readOAuthBody(request: Request): Promise<Record<string, string>> {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  const out: Record<string, string> = {};
  try {
    if (type.includes("application/json")) {
      const json = (await request.json()) as unknown;
      if (json && typeof json === "object") {
        for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
          if (typeof v === "string") out[k] = v;
          else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
        }
      }
      return out;
    }
    const text = await request.text();
    for (const [k, v] of new URLSearchParams(text)) out[k] = v;
  } catch {
    // A body that does not parse is the same as no body: every caller then answers invalid_request.
  }
  return out;
}

/** Client id and secret from HTTP Basic or from the body. Basic wins when both are present, per RFC 6749 §2.3.1. */
export function clientCredentialsFrom(request: Request, body: Record<string, string>): { clientId: string | null; clientSecret: string | null } {
  const auth = request.headers.get("authorization") ?? "";
  const m = /^\s*Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(auth);
  if (m) {
    try {
      const decoded = Buffer.from(m[1], "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      if (idx > 0) return { clientId: decodeURIComponent(decoded.slice(0, idx)), clientSecret: decodeURIComponent(decoded.slice(idx + 1)) };
    } catch {
      // Fall through to the body.
    }
  }
  return { clientId: body.client_id?.trim() || null, clientSecret: body.client_secret || null };
}
