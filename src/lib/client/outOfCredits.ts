/** Window event fired when the UI should show an out-of-credits state. */
export const OUT_OF_CREDITS_EVENT = "lnkdrp:out-of-credits";

/**
 * Dispatches an out-of-credits UI event (client-only).
 *
 * Exists so low-level API clients can trigger a global modal/CTA without direct component coupling.
 */
export function dispatchOutOfCredits() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OUT_OF_CREDITS_EVENT));
}


