/**
 * Where a link was created from, for the link row's `createdVia`.
 *
 * A bearer API key means an agent (`mcp` when it also identified itself with `x-lnkdrp-agent`,
 * which every MCP session sends); a cookie session is the web app.
 */
export function createdViaFor(request: Request): "web" | "api" | "mcp" {
  const bearer = (request.headers.get("authorization") ?? "").toLowerCase().startsWith("bearer ");
  if (!bearer) return "web";
  return request.headers.get("x-lnkdrp-agent") ? "mcp" : "api";
}
