/**
 * Environment and constants for the lnkdrp MCP server.
 *
 * Env: `LNKDRP_API_URL` (Next app base URL; defaults to `http://localhost:3001` outside production
 * and `https://lnkdrp.com` in production), `MCP_PORT` (default 8787), `MCP_PUBLIC_URL` (advertised
 * URL, default `http://localhost:${MCP_PORT}`), `NEXT_PUBLIC_REALTIME_URL` + `REALTIME_SECRET` /
 * `NEXTAUTH_SECRET` (optional; only used by `lnkdrp_share_pdf` to wait for "ready" over the
 * realtime channel instead of polling), `NEXT_PUBLIC_FEATURE_REQUESTS` (same build-time flag the
 * web app reads; surfaced read-only in `lnkdrp_whoami`'s `capabilities` so an agent can tell
 * "request repos don't exist on this deployment" from "no MCP tool happens to cover them yet"),
 * `LNKDRP_API_KEY` (stdio mode only).
 */

export const MCP_SERVER_NAME = "lnkdrp";
export const MCP_SERVER_VERSION = "0.1.0";

/** Sent as `x-lnkdrp-agent` until the MCP client identifies itself in `initialize`. */
export const DEFAULT_AGENT_HEADER = "mcp-client/unknown";

/** Per-request timeout for calls to the lnkdrp REST API. */
export const API_TIMEOUT_MS = 20_000;

/** Idempotency replay window and cache bound (per process). */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_MAX_ENTRIES = 1000;

/** Sessions with no request for this long are closed by the sweeper. */
export const SESSION_IDLE_MS = 60 * 60 * 1000;
export const SESSION_SWEEP_MS = 5 * 60 * 1000;

export type Config = {
  /** Base URL of the Next app (no trailing slash). Share URLs are `${apiUrl}/s/${shareId}`. */
  apiUrl: string;
  port: number;
  /** Advertised URL of this server (no trailing slash). */
  publicUrl: string;
  /** Realtime WebSocket URL, or null when the deployment has no realtime server. */
  realtimeUrl: string | null;
  /** Whether a ticket-signing secret is present (`REALTIME_SECRET` or `NEXTAUTH_SECRET`). */
  realtimeSecretConfigured: boolean;
  /** Whether request repos are enabled on this deployment at all (`NEXT_PUBLIC_FEATURE_REQUESTS=1`). */
  featureRequestsEnabled: boolean;
  isProduction: boolean;
};

/** Trim whitespace and trailing slashes. */
function trimSlashes(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/** Read the server configuration from `env` (defaults to `process.env`). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const isProduction = env.NODE_ENV === "production";
  const apiUrl = trimSlashes(env.LNKDRP_API_URL || (isProduction ? "https://lnkdrp.com" : "http://localhost:3001"));
  const portRaw = Number(env.MCP_PORT || 8787);
  const port = Number.isFinite(portRaw) && portRaw > 0 ? Math.floor(portRaw) : 8787;
  const publicUrl = trimSlashes(env.MCP_PUBLIC_URL || `http://localhost:${port}`);
  const realtimeUrl = trimSlashes(env.NEXT_PUBLIC_REALTIME_URL || "") || null;
  const realtimeSecretConfigured = Boolean((env.REALTIME_SECRET || env.NEXTAUTH_SECRET || "").trim());
  const featureRequestsEnabled = env.NEXT_PUBLIC_FEATURE_REQUESTS === "1";
  return { apiUrl, port, publicUrl, realtimeUrl, realtimeSecretConfigured, featureRequestsEnabled, isProduction };
}

/**
 * Log to stderr with a timestamp. Always stderr: in `--stdio` mode stdout is the MCP channel and a
 * stray line there would corrupt the protocol stream.
 */
export function log(...args: unknown[]): void {
  console.error(new Date().toISOString(), "[mcp]", ...args);
}
