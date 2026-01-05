import type { ErrorCategory, ErrorSeverity } from "@/lib/errors/types";
import { classifyErrorCode, classifyErrorSource } from "@/lib/errors/classifyError";

export type ApiErrorLoggingOptions<TCtx = unknown> = {
  /** Defaults to `api`. */
  category?: ErrorCategory;
  /** Defaults to a deterministic classifier (e.g. VALIDATION_ERROR/AUTH_ERROR/UNHANDLED_EXCEPTION). */
  code?: string;
  /** Defaults to `error`. */
  severity?: ErrorSeverity;
  /**
   * Optional context ids for correlation (workspace/user/upload/run/etc).
   * IMPORTANT: do not put secrets or tokens here.
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
   * Do NOT include request bodies, headers, cookies, third-party payloads, etc.
   */
  meta?: unknown | ((args: { err: unknown; request: Request; ctx: TCtx }) => unknown);
};

function isEdgeRuntime(): boolean {
  // Next.js Edge runtime exposes a global `EdgeRuntime` (string).
  return typeof (globalThis as any).EdgeRuntime !== "undefined";
}

/**
 * Wrap a Next.js App Router route handler to capture unhandled exceptions.
 *
 * This wrapper:
 * - logs best-effort to MongoDB (when enabled)
 * - rethrows the error so default Next.js behavior is preserved
 */
export function withApiErrorLogging<TReq extends Request = Request, TCtx = unknown>(
  handler: (request: TReq, ctx?: TCtx) => Promise<Response>,
  options?: ApiErrorLoggingOptions<TCtx>,
): (request: TReq, ctx?: TCtx) => Promise<Response> {
  return async (request: TReq, ctx?: TCtx) => {
    try {
      return await handler(request, ctx);
    } catch (err) {
      const category = options?.category ?? classifyErrorSource({ source: "api" });
      const code = options?.code ?? classifyErrorCode(err);

      // IMPORTANT: Logger is Node-only (Mongo/Mongoose). Never import it in Edge runtime.
      if (!isEdgeRuntime()) {
        const meta = typeof options?.meta === "function" ? options.meta({ err, request, ctx: ctx as TCtx }) : options?.meta;
        void import("@/lib/errors/logger").then(({ logErrorEvent }) =>
          logErrorEvent({
            severity: options?.severity ?? "error",
            category,
            code,
            err,
            request,
            ids: options?.ids,
            meta,
          }),
        );
      }
      throw err;
    }
  };
}


