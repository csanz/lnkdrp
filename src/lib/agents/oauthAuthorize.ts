/**
 * The authorization request, validated once for the consent page and once for its POST.
 *
 * Both sides must agree on what a valid request is, and the POST must not trust the page: the
 * hidden fields it carries are the client's parameters echoed back, and a forged POST could
 * carry anything. So the page renders only what `validateAuthorizeRequest` accepted, and the
 * POST re-runs the same function on the same fields before minting a code.
 *
 * The one rule above all others (RFC 6749 §4.1.2.1): never redirect to a `redirect_uri` that is
 * not the client's. A request with a bad client or a bad redirect gets an error page, not an
 * error redirect. Every other error is sent to the client the way it expects, in the redirect.
 */
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { OrgModel } from "@/lib/models/Org";
import type { ApiKeyScope } from "@/lib/models/ApiKey";
import { findClient, isValidCodeChallenge, redirectUriMatches, scopesFromParam, type RegisteredClient } from "@/lib/agents/oauth";
import { roleAtLeast, type OrgRole } from "@/lib/orgs/requireOrgRole";

/** The query parameters an authorization request carries, as strings or nothing. */
export type AuthorizeParams = Record<"client_id" | "redirect_uri" | "response_type" | "state" | "code_challenge" | "code_challenge_method" | "scope" | "resource", string | undefined>;

export const AUTHORIZE_PARAM_NAMES = ["client_id", "redirect_uri", "response_type", "state", "code_challenge", "code_challenge_method", "scope", "resource"] as const;

/** Read the eight parameters from anything string-keyed: `searchParams`, a form body. */
export function authorizeParamsFrom(source: Record<string, unknown> | URLSearchParams): AuthorizeParams {
  const get = (k: string): string | undefined => {
    const v = source instanceof URLSearchParams ? source.get(k) : source[k];
    if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : undefined;
    return typeof v === "string" ? v : undefined;
  };
  return {
    client_id: get("client_id"),
    redirect_uri: get("redirect_uri"),
    response_type: get("response_type"),
    state: get("state"),
    code_challenge: get("code_challenge"),
    code_challenge_method: get("code_challenge_method"),
    scope: get("scope"),
    resource: get("resource"),
  };
}

export type AuthorizeValidation =
  /** Show an error page. Nothing may be redirected anywhere. */
  | { kind: "page_error"; title: string; detail: string }
  /** Redirect to the client with an OAuth error. */
  | { kind: "redirect_error"; redirectUri: string; error: "invalid_request" | "invalid_scope" | "unsupported_response_type"; description: string; state: string | undefined }
  | { kind: "ok"; client: RegisteredClient; redirectUri: string; scopes: ApiKeyScope[]; codeChallenge: string; state: string | undefined; resource: string | null };

/** Validate an authorization request against the registered client. */
export async function validateAuthorizeRequest(p: AuthorizeParams): Promise<AuthorizeValidation> {
  if (!p.client_id) return { kind: "page_error", title: "Missing client", detail: "The request has no client_id. Start the connection again from your agent." };
  const client = await findClient(p.client_id);
  if (!client) return { kind: "page_error", title: "Unknown client", detail: "This client is not registered with lnkdrp. Remove lnkdrp from your agent and add it again; it will register itself." };

  const redirectUri = p.redirect_uri ?? "";
  const registered = client.redirectUris.find((r) => redirectUriMatches(r, redirectUri));
  if (!redirectUri || !registered) {
    return { kind: "page_error", title: "Redirect not allowed", detail: `The redirect address is not one “${client.clientName}” registered, so lnkdrp will not send it anywhere. Remove and re-add lnkdrp in your agent.` };
  }

  const state = p.state;
  if (p.response_type !== "code") {
    return { kind: "redirect_error", redirectUri, error: "unsupported_response_type", description: "response_type must be code.", state };
  }
  if ((p.code_challenge_method ?? "S256") !== "S256" || !isValidCodeChallenge(p.code_challenge)) {
    return { kind: "redirect_error", redirectUri, error: "invalid_request", description: "PKCE with S256 is required: send code_challenge and code_challenge_method=S256.", state };
  }
  const scopes = scopesFromParam(p.scope);
  if (!scopes) return { kind: "redirect_error", redirectUri, error: "invalid_scope", description: "Supported scopes are read and write.", state };

  let resource: string | null = null;
  if (p.resource) {
    try {
      const u = new URL(p.resource);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("scheme");
      resource = u.toString().slice(0, 500);
    } catch {
      return { kind: "redirect_error", redirectUri, error: "invalid_request", description: "resource must be an absolute http(s) URL.", state };
    }
  }

  return { kind: "ok", client, redirectUri, scopes, codeChallenge: p.code_challenge as string, state, resource };
}

/** Append OAuth response parameters to a redirect URI, keeping whatever query it already had. */
export function redirectWith(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (typeof v === "string") url.searchParams.set(k, v);
  return url.toString();
}

export type WorkspaceChoice = {
  id: string;
  name: string;
  isPersonal: boolean;
  role: OrgRole;
  /** What a grant in this workspace may carry: viewers get read only. */
  allowedScopes: ApiKeyScope[];
};

/** The workspaces a person may connect an agent to: every active membership, personal first. */
export async function workspacesForUser(userId: string): Promise<WorkspaceChoice[]> {
  if (!Types.ObjectId.isValid(userId)) return [];
  await connectMongo();
  const memberships = await OrgMembershipModel.find({ userId: new Types.ObjectId(userId), isDeleted: { $ne: true } })
    .select({ orgId: 1, role: 1 })
    .lean();
  const roleByOrg = new Map<string, OrgRole>();
  for (const m of memberships) {
    const role = m.role as OrgRole;
    if (!roleByOrg.has(String(m.orgId))) roleByOrg.set(String(m.orgId), role);
  }
  if (roleByOrg.size === 0) return [];
  const orgs = await OrgModel.find({ _id: { $in: Array.from(roleByOrg.keys()).map((id) => new Types.ObjectId(id)) }, isDeleted: { $ne: true } })
    .select({ name: 1, type: 1 })
    .lean();
  const out: WorkspaceChoice[] = orgs.map((o) => {
    const role = roleByOrg.get(String(o._id)) ?? "viewer";
    return {
      id: String(o._id),
      name: typeof o.name === "string" && o.name.trim() ? o.name : "Workspace",
      isPersonal: o.type === "personal",
      role,
      allowedScopes: roleAtLeast(role, "member") ? ["read", "write"] : ["read"],
    };
  });
  out.sort((a, b) => (a.isPersonal !== b.isPersonal ? (a.isPersonal ? -1 : 1) : a.name.localeCompare(b.name)));
  return out;
}
