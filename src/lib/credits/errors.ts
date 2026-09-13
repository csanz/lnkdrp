/**
 * Stable machine-readable error code for out-of-credits responses.
 *
 * Exists so clients can reliably detect the condition even if human-readable messages change.
 */
export const OUT_OF_CREDITS_CODE = "OUT_OF_CREDITS";

/**
 * Stable code for the Free daily brake (`dailyCreditCap`): the workspace still has credits, it
 * just cannot spend more today. Clients show different copy than for an exhausted balance.
 */
export const DAILY_CAP_CODE = "DAILY_CREDIT_CAP";

/** Returns true when an error is the daily credit brake rather than an empty balance. */
export function isDailyCapError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return String(msg || "").toLowerCase().includes("daily credit cap exceeded");
}

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


