/**
 * `GET /.well-known/oauth-authorization-server` — RFC 8414 metadata: where an MCP client
 * registers, sends its user, and exchanges codes. The MCP server's own well-known document
 * (`mcp/src/main.ts`) names this origin as the authorization server, and a client that follows
 * the MCP authorization spec fetches this next. Public, cacheable, CORS-open.
 */
import { NextResponse } from "next/server";

import { authorizationServerMetadata } from "@/lib/agents/oauth";
import { OAUTH_CORS_HEADERS, oauthOptions } from "@/lib/agents/oauthHttp";
import { getPublicSiteBase } from "@/lib/urls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(authorizationServerMetadata(getPublicSiteBase()), {
    headers: { "cache-control": "public, max-age=3600", ...OAUTH_CORS_HEADERS },
  });
}

export async function OPTIONS() {
  return oauthOptions();
}
