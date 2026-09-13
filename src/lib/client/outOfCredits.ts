/** Window event fired when the UI should show an out-of-credits state. */
export const OUT_OF_CREDITS_EVENT = "lnkdrp:out-of-credits";

/** Why AI is unavailable: the balance is empty, or the Free daily brake was hit (credits remain). */
export type OutOfCreditsReason = "exhausted" | "daily_cap";

/** Map a 402 body from the API (`code`) to the modal reason. */
export function outOfCreditsReasonFromCode(code: unknown): OutOfCreditsReason {
  return code === "DAILY_CREDIT_CAP" ? "daily_cap" : "exhausted";
}

/**
 * Dispatches an out-of-credits UI event (client-only).
 *
 * Exists so low-level API clients can trigger a global modal/CTA without direct component coupling.
 */
export function dispatchOutOfCredits(reason: OutOfCreditsReason = "exhausted") {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<{ reason: OutOfCreditsReason }>(OUT_OF_CREDITS_EVENT, { detail: { reason } }));
}


