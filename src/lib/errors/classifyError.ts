import type { ErrorCategory } from "@/lib/errors/types";

type Source = "api" | "cron" | "worker" | "stripe";

/**
 * Deterministic mapping from a known source to an ErrorEvent category.
 */
export function classifyErrorSource(args: { source: Source }): ErrorCategory {
  return args.source;
}

/**
 * Deterministic error code classification.
 *
 * Rules:
 * - ZodError -> VALIDATION_ERROR
 * - message contains "jwt" or "auth" (case-insensitive) -> AUTH_ERROR
 */
export function classifyErrorCode(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "ZodError") return "VALIDATION_ERROR";
    const msg = (err.message ?? "").toLowerCase();
    if (msg.includes("jwt") || msg.includes("auth")) return "AUTH_ERROR";
  } else if (typeof err === "string") {
    const msg = err.toLowerCase();
    if (msg.includes("jwt") || msg.includes("auth")) return "AUTH_ERROR";
  }
  return "UNHANDLED_EXCEPTION";
}


