export const OUT_OF_CREDITS_EVENT = "lnkdrp:out-of-credits";

export function dispatchOutOfCredits() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OUT_OF_CREDITS_EVENT));
}


