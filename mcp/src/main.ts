/**
 * lnkdrp MCP server — a thin, stateful translator from MCP tool calls to the lnkdrp REST API.
 *
 * Run: `npm run mcp` (tsx, reads .env.local) or `npm run mcp:prod` (`node --import tsx`). Deploy
 * anywhere that runs Node (Docker image in `mcp/Dockerfile`); it is NOT a Vercel function.
 * Env: see `config.ts`. Local stdio mode: `npm run mcp -- --stdio` with `LNKDRP_API_KEY` set.
 *
 * HTTP surface
 * - `POST/GET/DELETE /mcp` — Streamable HTTP transport with stateful sessions (`Mcp-Session-Id`).
 *   Every request must carry `Authorization: Bearer lnk_…`; missing/malformed → 401 before the
 *   transport sees it. A session is bound to the key that opened it (other keys → 401).
 * - `initialize` (a POST without a session id) calls `GET /api/agent/whoami` with the key and the
 *   `x-lnkdrp-agent: <client>/<version>` header from `clientInfo`. That call registers the
 *   connection (the key records the client name, which the realtime channel pushes to the
 *   dashboard). 401 from whoami → the session is refused with 401.
 * - `GET /healthz` → `{ ok, sessions, version, apiUrl }`.
 * - `GET /.well-known/oauth-protected-resource` → placeholder resource metadata (bearer keys only).
 *
 * The server never touches Mongo: every tool maps to REST calls made with the caller's own key,
 * so realtime fan-out to the browser happens for free when the API writes.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Server as HttpServer } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response } from "express";

import { agentHeaderFrom } from "./agent";
import { ApiClient, type Whoami } from "./api";
import { DEFAULT_AGENT_HEADER, MCP_SERVER_VERSION, SESSION_IDLE_MS, SESSION_SWEEP_MS, loadConfig, log, type Config } from "./config";
import type { ToolContext } from "./context";
import { isToolError } from "./errors";
import { IdempotencyStore } from "./idempotency";
import { createMcpServer } from "./server";

const config: Config = loadConfig();
const idempotency = new IdempotencyStore();

type Session = {
  id: string | null;
  /** sha256 of the bearer key, used to bind later requests to the session without comparing plaintext. */
  keyHash: Buffer;
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

/** The `lnk_…` bearer token from the request, or null when missing or not an API key. */
function bearerFrom(req: Request): string | null {
  const raw = req.header("authorization") ?? "";
  const m = /^\s*Bearer\s+(.+?)\s*$/i.exec(raw);
  const token = m ? m[1] : "";
  return token.startsWith(API_KEY_PREFIX) ? token : null;
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

/** 401 JSON with a `WWW-Authenticate` hint at the resource metadata. */
function unauthorized(res: Response, code: "unauthorized" | "key_revoked" = "unauthorized"): void {
  res
    .status(401)
    .set("www-authenticate", `Bearer resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource"`)
    .json({ error: code });
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
      unauthorized(res);
      return;
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
    log("initialize failed: whoami unreachable", err instanceof Error ? err.message : err);
    res.status(502).json({ error: "upstream", message: "Could not reach the lnkdrp API to verify the key." });
    return;
  }
  state.whoami = whoami;

  const server = createMcpServer(ctx);
  const session: Session = {
    id: null,
    keyHash: keyHashOf(key),
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
  };

  await server.connect(session.transport);
  await session.transport.handleRequest(req, res, req.body);
}

/** The Express app: health, resource metadata and the `/mcp` endpoint. */
function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "4mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, sessions: sessions.size, version: MCP_SERVER_VERSION, apiUrl: config.apiUrl });
  });

  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({ resource: config.publicUrl, authorization_servers: [], bearer_methods_supported: ["header"] });
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
  const httpServer: HttpServer = app.listen(config.port, () => {
    log(`listening on :${config.port}`, {
      apiUrl: config.apiUrl,
      publicUrl: config.publicUrl,
      realtime: config.realtimeUrl && config.realtimeSecretConfigured ? config.realtimeUrl : "off (polling only)",
    });
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
