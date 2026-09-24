/**
 * `POST /api/oauth/authorize` — where the consent form lands.
 *
 * The browser posts the client's parameters back, the chosen workspace and `decision`. This is
 * the only route that mints authorization codes, so it trusts nothing the form carried:
 * the request is validated again against the registered client, the session is read from the
 * cookie, and the workspace must be one the signed-in person is a member of. Then a 303 to the
 * client's redirect URI with `code` and `state`, or with `error=access_denied` on Cancel.
 *
 * CSRF: a same-origin form post carries `Origin`; anything else is refused. The session cookie
 * is `SameSite=Lax`, which already keeps a cross-site POST from carrying it, and the check here
 * makes that explicit rather than relying on it.
 */
import { NextResponse } from "next/server";

import { createAuthorizationCode } from "@/lib/agents/oauth";
import { authorizeParamsFrom, redirectWith, validateAuthorizeRequest, workspacesForUser } from "@/lib/agents/oauthAuthorize";
import { recordActivity } from "@/lib/activity/log";
import { tryResolveAuthUserId } from "@/lib/gating/actor";
import { errorJson } from "@/lib/http/errorResponse";
import { getPublicSiteBase } from "@/lib/urls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    let expectedOrigin: string;
    try {
      expectedOrigin = new URL(getPublicSiteBase()).origin;
    } catch {
      expectedOrigin = "";
    }
    if (!origin || (expectedOrigin && origin !== expectedOrigin && origin !== new URL(request.url).origin)) {
      return NextResponse.json({ error: "forbidden", message: "Cross-site form post refused." }, { status: 403, headers: NO_STORE });
    }

    const session = await tryResolveAuthUserId(request);
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });

    const form = new URLSearchParams(await request.text());
    const validation = await validateAuthorizeRequest(authorizeParamsFrom(form));
    if (validation.kind === "page_error") {
      return NextResponse.json({ error: "invalid_request", message: validation.detail }, { status: 400, headers: NO_STORE });
    }
    if (validation.kind === "redirect_error") {
      return NextResponse.redirect(redirectWith(validation.redirectUri, { error: validation.error, error_description: validation.description, state: validation.state }), 303);
    }

    const { client, redirectUri, state, codeChallenge, resource } = validation;
    if (form.get("decision") !== "allow") {
      return NextResponse.redirect(redirectWith(redirectUri, { error: "access_denied", error_description: "The person declined.", state }), 303);
    }

    const orgId = form.get("org_id") ?? "";
    const workspace = (await workspacesForUser(session.userId)).find((w) => w.id === orgId);
    if (!workspace) {
      return NextResponse.json({ error: "invalid_request", message: "Pick a workspace you belong to." }, { status: 400, headers: NO_STORE });
    }
    // A viewer may connect an agent, but the grant cannot carry more than the person has.
    const scopes = validation.scopes.filter((s) => workspace.allowedScopes.includes(s));
    if (scopes.length === 0) {
      return NextResponse.redirect(redirectWith(redirectUri, { error: "invalid_scope", error_description: "Your role in that workspace does not allow the requested access.", state }), 303);
    }

    const code = await createAuthorizationCode({ clientId: client.clientId, userId: session.userId, orgId: workspace.id, scopes, redirectUri, codeChallenge, resource });

    void recordActivity({
      orgId: workspace.id,
      userId: session.userId,
      actorKind: "user",
      type: "agent.authorized",
      meta: { name: client.clientName, clientId: client.clientId, scopes, workspace: workspace.name },
      request,
    });

    return NextResponse.redirect(redirectWith(redirectUri, { code, state }), 303);
  } catch (err) {
    return errorJson(err, { status: 500, publicMessage: "Could not complete the authorization", context: "[api/oauth/authorize] POST failed" });
  }
}
