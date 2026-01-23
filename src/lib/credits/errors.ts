/**
 * Stable machine-readable error code for out-of-credits responses.
 *
 * Exists so clients can reliably detect the condition even if human-readable messages change.
 */
export const OUT_OF_CREDITS_CODE = "OUT_OF_CREDITS";

/**
 * Returns true when an error indicates the user/workspace is out of credits.
 *
 * Exists to trigger global UI (modal/toast) from many different call sites without coupling.
 * Matches common server error strings used by credit gating.
 */
export function isOutOfCreditsError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const m = String(msg || "").toLowerCase();
  return (
    m.includes("insufficient credits") ||
    m.includes("on-demand monthly limit exceeded") ||
    m.includes("daily credit cap exceeded") ||
    m.includes("monthly credit cap exceeded")
  );
}


