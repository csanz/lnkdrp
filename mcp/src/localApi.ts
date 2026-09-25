/**
 * Is the lnkdrp API this MCP server talks to on the same machine?
 *
 * That is how a local MCP server is spotted: it decides whether `filePath` may be read from disk,
 * which inline size ceiling applies, and whether confirmations may be skipped outside production.
 * It has no imports of its own so that anything may use it without pulling in a tool module.
 */
/** True for an API URL that points at this same machine, which is how a local MCP server is spotted. */
export function isLocalApiUrl(apiUrl: string): boolean {
  let host: string;
  try {
    host = new URL(apiUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0.0.0.0") return true;
  // A literal address in 127.0.0.0/8, and nothing that merely starts with those characters. The
  // previous `/^127\./` matched the hostname `127.0.0.1.evil.com`, which is an ordinary DNS name
  // someone else controls — it resolves wherever they point it, and we would have called it
  // loopback. Four octets, each 0-255, anchored at both ends.
  const octets = host.split(".");
  if (octets.length !== 4) return false;
  if (!octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)) return false;
  return octets[0] === "127";
}
