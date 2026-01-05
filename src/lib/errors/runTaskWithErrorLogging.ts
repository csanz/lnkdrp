import type { ErrorCategory, ErrorSeverity } from "@/lib/errors/types";
import { classifyErrorCode, classifyErrorSource } from "@/lib/errors/classifyError";

export type RunTaskWithErrorLoggingOptions = {
  /** Human-readable task name (ex: "doc-metrics" or "rollup-doc-metrics:once"). */
  taskName: string;
  /** Optional source for consistent category defaults. */
  source?: "api" | "cron" | "worker" | "stripe";
  category?: ErrorCategory;
  code?: string;
  /** Defaults to `error`. */
  severity?: ErrorSeverity;
  /**
   * Optional correlation ids (workspace/user/upload/run/etc).
   * IMPORTANT: do not put secrets/tokens here.
   */
  ids?: {
    requestId?: string | null;
    workspaceId?: string | null;
    userId?: string | null;
    uploadId?: string | null;
    docId?: string | null;
    runId?: string | null;
    model?: string | null;
  };
  /**
   * Optional meta (must be safe + small; will be sanitized/truncated again).
   * Do NOT include raw third-party payloads or request bodies.
   */
  meta?: unknown;
};

/**
 * Wrap a cron/worker execution to capture thrown errors.
 *
 * This wrapper:
 * - logs best-effort to MongoDB (when enabled)
 * - rethrows (so existing error/exit behavior is preserved)
 */
export async function runTaskWithErrorLogging<T>(
  opts: RunTaskWithErrorLoggingOptions,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const category = opts.category ?? (opts.source ? classifyErrorSource({ source: opts.source }) : "unknown");
    const code = opts.code ?? classifyErrorCode(err);
    // Node-only (Mongo/Mongoose) — this wrapper is intended for Node cron/worker execution.
    void import("@/lib/errors/logger").then(({ logErrorEvent }) =>
      logErrorEvent({
        severity: opts.severity ?? "error",
        category,
        code,
        err,
        meta: { taskName: opts.taskName, ...(opts.meta ? { meta: opts.meta } : {}) },
        ids: opts.ids,
      }),
    );
    throw err;
  }
}


