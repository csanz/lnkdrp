/**
 * `x-lnkdrp-agent` header from the MCP client's `clientInfo` (see `src/lib/activity/log.ts` for
 * the parser on the API side: `<client>/<version>`, client `[a-z0-9._-]`, max 64 chars each).
 */
import { DEFAULT_AGENT_HEADER } from "./config";

const MAX_LEN = 64;

/** Normalise a client name to the API's client-id alphabet (`"Claude Code"` -> `"claude-code"`). */
export function normalizeClientName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_LEN);
}

/** Keep a version only when it is printable ASCII without spaces. */
export function normalizeClientVersion(raw: unknown): string {
  if (typeof raw !== "string") return "unknown";
  const v = raw.trim().slice(0, MAX_LEN);
  return v && /^[\x21-\x7e]+$/.test(v) ? v : "unknown";
}

/** Header value for a `clientInfo`-like object; `mcp-client/unknown` when nothing usable is known. */
export function agentHeaderFrom(info: { name?: unknown; version?: unknown } | null | undefined): string {
  const client = normalizeClientName(info?.name);
  if (!client) return DEFAULT_AGENT_HEADER;
  return `${client}/${normalizeClientVersion(info?.version)}`;
}
