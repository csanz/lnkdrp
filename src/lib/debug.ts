/**
 * Minimal debug logger with env-controlled verbosity.
 *
 * - Server: set `DEBUG_LEVEL=1` (or higher) to enable logs.
 * - Back-compat: if you set `DEBUG_MODE=verbose`, we treat it as `DEBUG_LEVEL=2`.
 * - Client: we mirror server `DEBUG_LEVEL` into `window.__DEBUG_LEVEL__`
 *   (in `src/app/layout.tsx`), so you don't need a NEXT_PUBLIC env var.
 *
 * Levels:
 * 0 = silent
 * 1 = flow-level events (API calls, state transitions)
 * 2 = verbose (payload shapes, timings)
 */

declare global {
  interface Window {
    __DEBUG_LEVEL__?: number;
  }
}
/** Read the configured debug level from runtime globals and environment. */
function readDebugLevel(): number {
  // Client-side runtime override injected by the server into the HTML.
  if (typeof window !== "undefined") {
    const w = window.__DEBUG_LEVEL__;
    if (typeof w === "number" && Number.isFinite(w)) return w;
  }

  const envRawServer = process.env.DEBUG_LEVEL;
  const envModeServer = process.env.DEBUG_MODE;
  const envRawClient = process.env.NEXT_PUBLIC_DEBUG_LEVEL;
  const raw =
    // Server-side env (Node runtime)
    envRawServer ??
    // Back-compat server env: DEBUG_MODE=verbose
    (envModeServer === "verbose" ? "2" : undefined) ??
    // Client-side env (Next only exposes NEXT_PUBLIC_*)
    envRawClient ??
    // Default: be verbose in dev so background pipelines are visible.
    (process.env.NODE_ENV === "development" ? "1" : "0");
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}
/** Return whether debug logging is enabled at the given level. */
export function debugEnabled(level = 1): boolean {
  return readDebugLevel() >= level;
}
/** Log to console at the given level (no-op when disabled). */
export function debugLog(level: number, ...args: unknown[]) {
  if (!debugEnabled(level)) return;
  console.log(...args);
}
/** Warn to console at the given level (no-op when disabled). */
export function debugWarn(level: number, ...args: unknown[]) {
  if (!debugEnabled(level)) return;
  console.warn(...args);
}
/** Error to console at the given level (no-op when disabled). */
export function debugError(level: number, ...args: unknown[]) {
  if (!debugEnabled(level)) return;
  console.error(...args);
}

