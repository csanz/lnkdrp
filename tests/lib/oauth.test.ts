/**
 * OAuth for the MCP server: the pure half.
 *
 * What a client may register as a redirect, how a presented redirect is matched, PKCE, scopes,
 * the registration body, the metadata document and the token shapes. None of it touches Mongo;
 * the endpoint behaviour on top of it is one call each into `src/lib/agents/oauth.ts`.
 */
import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));

const {
  OAUTH_ACCESS_PREFIX,
  authorizationServerMetadata,
  isValidCodeChallenge,
  isValidRedirectUri,
  looksLikeOAuthAccessToken,
  looksLikeOAuthClientId,
  looksLikeOAuthRefreshToken,
  parseClientRegistration,
  pkceMatches,
  redirectUriMatches,
  scopesFromParam,
} = await import("@/lib/agents/oauth");
const { clientCredentialsFrom, oauthError, readOAuthBody } = await import("@/lib/agents/oauthHttp");
const { authorizeParamsFrom, redirectWith } = await import("@/lib/agents/oauthAuthorize");

const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");

describe("redirect URIs", () => {
  test("https anywhere, http only on the loopback, private-use schemes, nothing else", () => {
    expect(isValidRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isValidRedirectUri("http://localhost:3334/callback")).toBe(true);
    expect(isValidRedirectUri("http://127.0.0.1:52341/oauth/callback")).toBe(true);
    expect(isValidRedirectUri("cursor://anysphere.cursor-retrieval/oauth/user-lnkdrp/callback")).toBe(true);
    expect(isValidRedirectUri("vscode://ms-vscode.mcp/authorize")).toBe(true);
    expect(isValidRedirectUri("http://example.com/callback")).toBe(false);
    expect(isValidRedirectUri("https://example.com/cb#frag")).toBe(false);
    expect(isValidRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isValidRedirectUri("data:text/html,hi")).toBe(false);
    expect(isValidRedirectUri("not a url")).toBe(false);
    expect(isValidRedirectUri("")).toBe(false);
    expect(isValidRedirectUri(42)).toBe(false);
  });

  test("a loopback redirect matches on any port; everything else exactly", () => {
    expect(redirectUriMatches("http://localhost:1234/cb", "http://localhost:9999/cb")).toBe(true);
    expect(redirectUriMatches("http://127.0.0.1/cb", "http://127.0.0.1:5000/cb")).toBe(true);
    expect(redirectUriMatches("http://localhost:1234/cb", "http://localhost:1234/other")).toBe(false);
    expect(redirectUriMatches("https://a.example/cb", "https://a.example:444/cb")).toBe(false);
    expect(redirectUriMatches("https://a.example/cb", "https://a.example/cb")).toBe(true);
    expect(redirectUriMatches("cursor://x/cb", "cursor://x/cb")).toBe(true);
    expect(redirectUriMatches("cursor://x/cb", "cursor://y/cb")).toBe(false);
  });
});

describe("PKCE", () => {
  test("S256 of the verifier must equal the challenge", () => {
    expect(isValidCodeChallenge(challenge)).toBe(true);
    expect(pkceMatches(verifier, challenge)).toBe(true);
    expect(pkceMatches(verifier + "x", challenge)).toBe(false);
    expect(pkceMatches("short", challenge)).toBe(false);
    expect(pkceMatches(undefined, challenge)).toBe(false);
    expect(isValidCodeChallenge("plain-text-challenge")).toBe(false);
  });
});

describe("scopes and registration", () => {
  test("absent scope means everything; unknown scope is an error, not ignored", () => {
    expect(scopesFromParam(undefined)).toEqual(["read", "write"]);
    expect(scopesFromParam("")).toEqual(["read", "write"]);
    expect(scopesFromParam("read")).toEqual(["read"]);
    expect(scopesFromParam("read write read")).toEqual(["read", "write"]);
    expect(scopesFromParam("admin")).toBeNull();
  });

  test("registration keeps what we store and refuses what we cannot honour", () => {
    const ok = parseClientRegistration({
      client_name: "Claude Code",
      redirect_uris: ["http://localhost:3334/callback", "http://localhost:3334/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_uri: "https://claude.ai",
    });
    expect(ok).toEqual({
      ok: true,
      value: { clientName: "Claude Code", redirectUris: ["http://localhost:3334/callback"], tokenEndpointAuthMethod: "none", clientUri: "https://claude.ai/" },
    });
    expect(parseClientRegistration({ redirect_uris: [] })).toMatchObject({ ok: false, error: "invalid_redirect_uri" });
    expect(parseClientRegistration({ redirect_uris: ["http://evil.example/cb"] })).toMatchObject({ ok: false, error: "invalid_redirect_uri" });
    expect(parseClientRegistration({ redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "private_key_jwt" })).toMatchObject({ ok: false, error: "invalid_client_metadata" });
    expect(parseClientRegistration({ redirect_uris: ["https://a.example/cb"], grant_types: ["implicit"] })).toMatchObject({ ok: false, error: "invalid_client_metadata" });
    expect(parseClientRegistration("nope")).toMatchObject({ ok: false, error: "invalid_client_metadata" });
    // A missing name is not a reason to refuse; the consent screen needs some word.
    expect(parseClientRegistration({ redirect_uris: ["https://a.example/cb"] })).toMatchObject({ ok: true, value: { clientName: "MCP client" } });
  });
});

describe("metadata and token shapes", () => {
  test("the RFC 8414 document points every endpoint at the site base, S256 only", () => {
    const m = authorizationServerMetadata("https://www.lnkdrp.com/");
    expect(m.issuer).toBe("https://www.lnkdrp.com");
    expect(m.authorization_endpoint).toBe("https://www.lnkdrp.com/connect/authorize");
    expect(m.token_endpoint).toBe("https://www.lnkdrp.com/api/oauth/token");
    expect(m.registration_endpoint).toBe("https://www.lnkdrp.com/api/oauth/register");
    expect(m.revocation_endpoint).toBe("https://www.lnkdrp.com/api/oauth/revoke");
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
    expect(m.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
  });

  test("token, refresh and client id shapes are strict, and a key never passes as a token", () => {
    expect(looksLikeOAuthAccessToken(`${OAUTH_ACCESS_PREFIX}${"a".repeat(40)}`)).toBe(true);
    expect(looksLikeOAuthAccessToken(`${OAUTH_ACCESS_PREFIX}${"a".repeat(39)}`)).toBe(false);
    expect(looksLikeOAuthAccessToken(`lnk_${"a".repeat(32)}`)).toBe(false);
    expect(looksLikeOAuthRefreshToken(`lnkr_${"b".repeat(48)}`)).toBe(true);
    expect(looksLikeOAuthRefreshToken(`lnko_${"b".repeat(40)}`)).toBe(false);
    expect(looksLikeOAuthClientId(`oac_${"c".repeat(24)}`)).toBe(true);
    expect(looksLikeOAuthClientId("oac_short")).toBe(false);
  });
});

describe("HTTP conventions", () => {
  test("form and JSON bodies read the same; Basic beats body credentials", async () => {
    const form = new Request("https://x/api/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=refresh_token&client_id=oac_1&refresh_token=lnkr_x",
    });
    const fromForm = await readOAuthBody(form);
    expect(fromForm).toEqual({ grant_type: "refresh_token", client_id: "oac_1", refresh_token: "lnkr_x" });
    expect(clientCredentialsFrom(form, fromForm)).toEqual({ clientId: "oac_1", clientSecret: null });

    const json = new Request("https://x/api/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from("oac_2:s3cret").toString("base64")}` },
      body: JSON.stringify({ grant_type: "authorization_code", client_id: "oac_1", code: "abc" }),
    });
    const fromJson = await readOAuthBody(json);
    expect(fromJson.code).toBe("abc");
    expect(clientCredentialsFrom(json, fromJson)).toEqual({ clientId: "oac_2", clientSecret: "s3cret" });
  });

  test("errors are RFC 6749 §5.2 bodies, never cached, and invalid_client challenges", async () => {
    const res = oauthError(401, "invalid_client", "Unknown client.");
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("www-authenticate")).toContain("Basic");
    expect(await res.json()).toEqual({ error: "invalid_client", error_description: "Unknown client." });
  });

  test("authorize parameters read from search params and forms alike; the redirect keeps the client's query", () => {
    const qs = new URLSearchParams({ client_id: "oac_1", redirect_uri: "http://localhost:1/cb?x=1", response_type: "code", state: "s" });
    expect(authorizeParamsFrom(qs)).toMatchObject({ client_id: "oac_1", response_type: "code", state: "s", scope: undefined });
    expect(authorizeParamsFrom({ client_id: ["oac_2"], scope: "read" })).toMatchObject({ client_id: "oac_2", scope: "read" });
    expect(redirectWith("http://localhost:1/cb?x=1", { code: "c", state: "s", error: undefined })).toBe("http://localhost:1/cb?x=1&code=c&state=s");
  });
});
