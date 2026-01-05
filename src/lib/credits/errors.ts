export const OUT_OF_CREDITS_CODE = "OUT_OF_CREDITS";

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


