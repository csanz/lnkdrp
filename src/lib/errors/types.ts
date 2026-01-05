/**
 * Error logging types.
 *
 * Kept in a small standalone module to avoid circular deps between the
 * Mongoose model and the logger implementation.
 */

export type ErrorSeverity = "error" | "warn" | "info";

export type ErrorCategory =
  | "api"
  | "worker"
  | "cron"
  | "stripe"
  | "db"
  | "auth"
  | "ai"
  | "credits"
  | "unknown";


