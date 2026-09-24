/**
 * lnkdrp MCP server — a thin, stateful translator from MCP tool calls to the lnkdrp REST API.
 *
 * Run: `npm run mcp` (tsx, reads .env.local) or `npm run mcp:prod` (`node --import tsx`). Deploy
 * anywhere that runs Node (Docker image in `mcp/Dockerfile`); it is NOT a Vercel function.
 * Env: see `config.ts`. Local stdio mode: `npm run mcp -- --stdio` with `LNKDRP_API_KEY` set.
 *
 * HTTP surface
 * - `POST/GET/DELETE /mcp` — Streamable HTTP transport with stateful sessions (`Mcp-Session-Id`).
 *   Every request must carry `Authorization: Bearer lnk_…` (an API key) or `Bearer lnko_…` (an
 *   OAuth access token); missing/malformed → 401 before the transport sees it. A session is bound
 *   to the credential that opened it: the key, or for OAuth the grant, since its token rotates
 *   every hour and the same session must survive the refresh (other credentials → 401).
 * - `initialize` (a POST without a session id) calls `GET /api/agent/whoami` with the key and the
 *   `x-lnkdrp-agent: <client>/<version>` header from `clientInfo`. That call registers the
 *   connection (the key records the client name, which the realtime channel pushes to the
 *   dashboard). 401 from whoami → the session is refused with 401.
 * - `GET /healthz` → `{ ok, sessions, version, apiUrl, confirmations }`.
 * - `GET /.well-known/oauth-protected-resource` → RFC 9728 resource metadata naming the app as
 *   the authorization server, which is how an OAuth-capable client finds the consent flow.
 *
 * The server never touches Mongo: every tool maps to REST calls made with the caller's own key,
 * so realtime fan-out to the browser happens for free when the API writes.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Server as HttpServer } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { confirmationsSkipRequestedButUnsafe, confirmationsEnforced } from "./confirm";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response } from "express";

import { UPLOAD_MAX_BASE64_CHARS } from "../../src/lib/limits/uploads";
import { agentHeaderFrom } from "./agent";
import { ApiClient, type Whoami } from "./api";
import { DEFAULT_AGENT_HEADER, MCP_SERVER_VERSION, SESSION_IDLE_MS, SESSION_SWEEP_MS, loadConfig, log, type Config } from "./config";
import type { ToolContext } from "./context";
import { isToolError, initializeFailureResponse } from "./errors";
import { IdempotencyStore } from "./idempotency";
import { createMcpServer } from "./server";

const config: Config = loadConfig();
const idempotency = new IdempotencyStore();

type Session = {
  id: string | null;
  /** sha256 of the bearer that last authenticated this session; compared before any plaintext work. */
  keyHash: Buffer;
  /** The key id or OAuth grant id from whoami: what the session is really bound to. */
  credentialId: string;
  agentHeader: string;
  whoami: Whoami;
  api: ApiClient;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  createdAt: number;
  lastSeenAt: number;
};

const sessions = new Map<string, Session>();

const API_KEY_PREFIX = "lnk_";
/** OAuth access tokens minted by the app's authorization server (`src/lib/agents/oauth.ts`). */
const OAUTH_ACCESS_PREFIX = "lnko_";

/** The bearer token from the request, or null when missing or of a shape we never issued. */
function bearerFrom(req: Request): string | null {
  const raw = req.header("authorization") ?? "";
  const m = /^\s*Bearer\s+(.+?)\s*$/i.exec(raw);
  const token = m ? m[1] : "";
  return token.startsWith(API_KEY_PREFIX) || token.startsWith(OAUTH_ACCESS_PREFIX) ? token : null;
}

/** sha256 of a key, for constant-time comparison. */
function keyHashOf(key: string): Buffer {
  return createHash("sha256").update(key).digest();
}

/** Whether `key` is the key that opened `session`. */
function sameKey(session: Session, key: string): boolean {
  const h = keyHashOf(key);
  return h.length === session.keyHash.length && timingSafeEqual(h, session.keyHash);
}

/**
 * 401 JSON with a `WWW-Authenticate` hint at the resource metadata, and a sentence a human can act
 * on.
 *
 * The bare `{"error":"unauthorized"}` was correct and useless. This server authenticates with an
 * API key and advertises no OAuth authorization server, so a client that expects to authenticate by
 * OAuth gets a 401 it cannot resolve by retrying, by re-authorising, or by anything else it knows
 * how to do — and the person watching sees "cannot connect", which reads as a network fault. Say
 * which of the two it is and where the key comes from; the error `code` stays machine-readable and
 * unchanged for anything parsing it.
 */
function unauthorized(res: Response, code: "unauthorized" | "key_revoked" = "unauthorized"): void {
  const message =
    code === "key_revoked"
      ? `That credential has been revoked. Sign in again from your client, or create a new key at ${config.apiUrl}/connect and update this client's Authorization header.`
      : `This server takes a lnkdrp API key ("Authorization: Bearer lnk_…", from ${config.apiUrl}/connect) or an OAuth access token from the authorization server at ${config.apiUrl}. Most clients handle OAuth for you: add the server with no header and sign in when prompted.`;
  res
    .status(401)
    .set("www-authenticate", `Bearer resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource"`)
    .json({ error: code, message });
}

/** A JSON-RPC error body with the given HTTP status. */
function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

/** Build the per-session objects; `whoami` must be filled in by the caller before use. */
function buildSessionParts(key: string, agentHeader: string): { api: ApiClient; ctx: ToolContext; state: { agentHeader: string; whoami: Whoami | null } } {
  const state = { agentHeader, whoami: null as Whoami | null };
  const api = new ApiClient({ baseUrl: config.apiUrl, key, agent: () => state.agentHeader });
  const ctx: ToolContext = {
    config,
    api,
    whoami: () => {
      if (!state.whoami) throw new Error("session not initialised");
      return state.whoami;
    },
    setWhoami: (next) => {
      state.whoami = next;
    },
    idempotency,
  };
  return { api, ctx, state };
}

/** `params.clientInfo` from an `initialize` request body, if present. */
function clientInfoFrom(body: unknown): { name?: unknown; version?: unknown } | null {
  const params = (body as { params?: { clientInfo?: unknown } } | null)?.params;
  const info = params?.clientInfo;
  return info && typeof info === "object" ? (info as { name?: unknown; version?: unknown }) : null;
}

/** Close a session's transport and server and forget it. */
async function closeSession(session: Session, reason: string): Promise<void> {
  if (session.id) sessions.delete(session.id);
  log("session closed", { id: session.id, agent: session.agentHeader, reason });
  await Promise.allSettled([session.transport.close(), session.server.close()]);
}

/**
 * Accept a new bearer on an existing session when it resolves to the same credential.
 *
 * One REST call, and only on the request where the token changed. Returns `true` when rebound,
 * otherwise the failure code to answer with.
 */
async function rebindSession(session: Session, key: string): Promise<true | "unauthorized" | "key_revoked"> {
  try {
    const probe = new ApiClient({ baseUrl: config.apiUrl, key, agent: () => session.agentHeader });
    const who = await probe.whoami();
    if (!who.credentialId || who.credentialId !== session.credentialId) return "unauthorized";
    session.keyHash = keyHashOf(key);
    session.api.setKey(key);
    log("session rebound to refreshed token", { id: session.id, agent: session.agentHeader });
    return true;
  } catch (err) {
    if (isToolError(err) && err.code === "key_revoked") return "key_revoked";
    return "unauthorized";
  }
}

/** Bearer gate, session lookup or creation, then hand the request to the session transport. */
async function handleMcp(req: Request, res: Response): Promise<void> {
  const key = bearerFrom(req);
  if (!key) {
    unauthorized(res);
    return;
  }

  const sessionId = req.header("mcp-session-id");
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      jsonRpcError(res, 404, -32001, "Session not found");
      return;
    }
    if (!sameKey(session, key)) {
      // An OAuth client rotates its access token every hour and keeps the session. The new token
      // is accepted when whoami says it belongs to the credential this session was opened with;
      // anything else is another workspace's credential on someone else's session, and is refused.
      const rebound = key.startsWith(OAUTH_ACCESS_PREFIX) && (await rebindSession(session, key));
      if (rebound !== true) {
        unauthorized(res, rebound === "key_revoked" ? "key_revoked" : "unauthorized");
        return;
      }
    }
    session.lastSeenAt = Date.now();
    await session.transport.handleRequest(req, res, req.body);
    return;
  }

  if (req.method !== "POST" || !isInitializeRequest(req.body)) {
    jsonRpcError(res, 400, -32000, "Bad Request: No valid session ID provided");
    return;
  }

  // New session: register the connection with whoami before the transport answers `initialize`.
  const agentHeader = agentHeaderFrom(clientInfoFrom(req.body));
  const { api, ctx, state } = buildSessionParts(key, agentHeader);
  let whoami: Whoami;
  try {
    whoami = await api.whoami();
  } catch (err) {
    if (isToolError(err) && (err.code === "unauthorized" || err.code === "key_revoked")) {
      log("initialize refused", { agent: agentHeader, code: err.code });
      unauthorized(res, err.code);
      return;
    }
    const answer = initializeFailureResponse(err);
    log(answer.log, answer.status === 429 ? { agent: agentHeader } : err instanceof Error ? err.message : err);
    res.status(answer.status).json(answer.body);
    return;
  }
  state.whoami = whoami;

  const server = createMcpServer(ctx);
  const session: Session = {
    id: null,
    keyHash: keyHashOf(key),
    credentialId: whoami.credentialId,
    agentHeader,
    whoami,
    api,
    server,
    transport: new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        session.id = id;
        sessions.set(id, session);
        log("session opened", { id, agent: session.agentHeader, org: whoami.orgId, keyPrefix: whoami.keyPrefix, sessions: sessions.size });
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    }),
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  };
  session.transport.onclose = () => {
    if (session.id) sessions.delete(session.id);
  };
  // The transport parsed `initialize` for real; refresh the attribution header from what the SDK saw.
  server.server.oninitialized = () => {
    const known = server.server.getClientVersion();
    if (known) {
      const header = agentHeaderFrom(known);
      if (header !== DEFAULT_AGENT_HEADER) {
        session.agentHeader = header;
        state.agentHeader = header;
      }
    }
    // What the client can do for us. Whether it declares `elicitation` decides how the destructive
    // tools confirm with the human: a real prompt through the protocol, or the `confirm: true`
    // fallback that makes the agent do the asking. Logged so a live connection answers the question
    // instead of a guess.
    const caps = server.server.getClientCapabilities();
    log(`client capabilities: ${JSON.stringify(caps ?? {})} (client ${known?.name ?? "?"}/${known?.version ?? "?"})`);
  };

  await server.connect(session.transport);
  await session.transport.handleRequest(req, res, req.body);
}

/** The Express app: health, resource metadata and the `/mcp` endpoint. */
function createApp() {
  const app = express();
  app.disable("x-powered-by");
  // Derived from the tools' own fileBase64 ceiling rather than written down again: base64 costs
  // ~4/3 of the decoded size, and the tool-call JSON adds its own envelope on top. A request right
  // at the documented limit must clear this layer too, or a legitimate call gets Express's raw
  // "request entity too large" HTML instead of the tool's clean `too_large` error. Measured live
  // at the old numbers: a payload just over the tools' ceiling tripped Express first and the
  // tool's own validation never ran. Note this only bounds `fileBase64`; `filePath` sends a path,
  // so a large local file never travels through here at all.
  /**
   * The bearer check goes in front of the body parser, and the large limit only behind it.
   *
   * `express.json` buffers and parses the whole body before any route handler runs, so an
   * anonymous POST carrying 66 MB of JSON was fully materialised in memory and only then answered
   * 401. Measured in the Fly container this ships as (512 MB, a 259 MB V8 heap): one such request
   * took it to 235 MiB, and six in parallel killed it with "Reached heap limit". mcp.lnkdrp.com is
   * a single machine - sessions live in a process-local Map, so it has to be - which means anyone
   * who knows the hostname could end every connected agent's session in a loop, with no API key.
   *
   * Two changes, both cheap. A request with no bearer is now refused before a byte is buffered.
   * And the large limit applies only to `/mcp`, since `/healthz` and the well-known document need
   * kilobytes; a junk body aimed anywhere else meets the default 100 KB.
   */
  app.use("/mcp", (req, res, next) => {
    if (!bearerFrom(req)) {
      unauthorized(res);
      return;
    }
    next();
  });
  app.use("/mcp", express.json({ limit: UPLOAD_MAX_BASE64_CHARS + 2 * 1024 * 1024 }));
  app.use(express.json());

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      sessions: sessions.size,
      version: MCP_SERVER_VERSION,
      apiUrl: config.apiUrl,
      // "enforced" or "skipped": whether a destructive tool will stop and ask a human.
      confirmations: confirmationsEnforced() ? "enforced" : "skipped",
    });
  });

  /**
   * RFC 9728 protected-resource metadata: the document an OAuth-capable client reads after its
   * first 401. `authorization_servers` names the app, whose
   * `/.well-known/oauth-authorization-server` lists registration, consent and token endpoints
   * (`src/lib/agents/oauth.ts`). `resource_documentation` still points at the page that issues
   * keys, for a client or a person who would rather paste one.
   */
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.set("access-control-allow-origin", "*");
    res.json({
      resource: config.publicUrl,
      authorization_servers: [config.apiUrl],
      bearer_methods_supported: ["header"],
      scopes_supported: ["read", "write"],
      resource_documentation: `${config.apiUrl}/connect`,
    });
  });

  const mcp = (req: Request, res: Response) => {
    handleMcp(req, res).catch((err) => {
      log("mcp request failed", err instanceof Error ? (err.stack ?? err.message) : err);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal error");
    });
  };
  app.post("/mcp", mcp);
  app.get("/mcp", mcp);
  app.delete("/mcp", mcp);

  return app;
}

/** Streamable HTTP mode (default). */
async function runHttp(): Promise<void> {
  const app = createApp();
  const skippingConfirmations =
    !confirmationsSkipRequestedButUnsafe() && /^(1|true|yes)$/i.test((process.env.LNKDRP_SKIP_CONFIRMATIONS || "").trim());
  const httpServer: HttpServer = app.listen(config.port, () => {
    log(`listening on :${config.port}`, {
      apiUrl: config.apiUrl,
      publicUrl: config.publicUrl,
      realtime: config.realtimeUrl && config.realtimeSecretConfigured ? config.realtimeUrl : "off (polling only)",
      ...(skippingConfirmations ? { confirmations: "SKIPPED (dev database)" } : {}),
    });
    // A safety switch that was asked for and refused has to say so out loud: the operator otherwise
    // believes deletes are unprompted, and finds out they are not by being prompted mid-test — or
    // worse, believes the opposite.
    if (confirmationsSkipRequestedButUnsafe()) {
      console.error(
        `[mcp] LNKDRP_SKIP_CONFIRMATIONS is set but IGNORED: ${config.apiUrl} is not localhost, so deletes act on ` +
          "real data and will still ask for confirmation. Unset it, or point LNKDRP_API_URL at a dev database.",
      );
    }
  });
  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[mcp] port ${config.port} is already in use. Another MCP server is running; stop it or set MCP_PORT.`);
    } else {
      console.error("[mcp] server error", err);
    }
    process.exit(1);
  });

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const session of Array.from(sessions.values())) {
      if (session.lastSeenAt < cutoff) void closeSession(session, "idle");
    }
    idempotency.sweep();
  }, SESSION_SWEEP_MS);
  sweeper.unref();

  const shutdown = async () => {
    clearInterval(sweeper);
    await Promise.allSettled(Array.from(sessions.values()).map((s) => closeSession(s, "shutdown")));
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

/** `--stdio` mode: one session on stdin/stdout, key from `LNKDRP_API_KEY`. */
async function runStdio(): Promise<void> {
  const key = (process.env.LNKDRP_API_KEY || "").trim();
  if (!key.startsWith(API_KEY_PREFIX)) {
    console.error("[mcp] --stdio needs LNKDRP_API_KEY=lnk_… in the environment");
    process.exit(1);
  }
  const { api, ctx, state } = buildSessionParts(key, DEFAULT_AGENT_HEADER);
  const server = createMcpServer(ctx);
  server.server.oninitialized = () => {
    const known = server.server.getClientVersion();
    if (known) state.agentHeader = agentHeaderFrom(known);
    // Registers the connection (with the client name) the moment the client initialises.
    api
      .whoami()
      .then((w) => {
        state.whoami = w;
        log("stdio session ready", { agent: state.agentHeader, org: w.orgId, keyPrefix: w.keyPrefix });
      })
      .catch((err) => log("stdio whoami failed; tools will report the error", err instanceof Error ? err.message : err));
  };
  // Verify the key up front so a bad key fails loudly instead of at the first tool call.
  try {
    state.whoami = await api.whoami();
  } catch (err) {
    console.error("[mcp] key verification failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
  await server.connect(new StdioServerTransport());
  log("stdio transport connected", { apiUrl: config.apiUrl });
}

const main = process.argv.includes("--stdio") ? runStdio : runHttp;
main().catch((err) => {
  console.error("[mcp] fatal", err);
  process.exit(1);
});
