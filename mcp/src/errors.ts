/**
 * Tool error model for the lnkdrp MCP server.
 *
 * Every tool returns either the success envelope (`toolResult`) or the error envelope
 * (`toolErrorResult`): `{ isError: true, content: [{ type: "text", text: JSON.stringify({ error:
 * { code, message, details? } }) }] }`. REST failures are mapped to a stable `code` by
 * `mapApiError`; anything unexpected becomes `upstream`.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { log } from "./config";

export type ToolErrorCode =
  | "unauthorized"
  | "key_revoked"
  | "forbidden"
  | "not_found"
  | "validation"
  | "out_of_credits"
  | "rate_limited"
  | "fetch_blocked"
  | "unsupported_content_type"
  | "too_large"
  | "plan_limit"
  | "upstream";

export type ToolErrorDetails = Record<string, unknown>;

/** A tool failure with a stable machine-readable code. */
export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly details: ToolErrorDetails | undefined;
  /** HTTP status of the REST response that produced this error, when there was one. */
  readonly status: number | undefined;

  constructor(code: ToolErrorCode, message: string, opts: { details?: ToolErrorDetails; status?: number } = {}) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.details = opts.details;
    this.status = opts.status;
  }

  /** Copy with extra `details` merged in (used to attach ids the agent can recover with). */
  withDetails(extra: ToolErrorDetails): ToolError {
    return new ToolError(this.code, this.message, { details: { ...(this.details ?? {}), ...extra }, status: this.status });
  }
}

/** Type guard for `ToolError`. */
export function isToolError(err: unknown): err is ToolError {
  return err instanceof ToolError;
}

/** Narrow to a plain object, else `{}`. */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A string value or the empty string. */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const FETCH_BLOCKED_RE = /failed to fetch url|url is not allowed|timed out fetching|only http\(s\) urls|empty pdf|missing url/i;
const TOO_LARGE_RE = /too large/i;

/**
 * Map a non-2xx lnkdrp REST response to a `ToolError`.
 *
 * Routes that go through `errorJson` return `{ error: "unauthorized" | "key_revoked" | "forbidden" }`
 * with 401/403; a few older routes catch everything themselves and surface the same failures as
 * `{ error: "Invalid API key." }` with a 400/500, so the message is inspected too.
 */
export function mapApiError(input: { status: number; body: unknown; method: string; path: string; siteUrl: string }): ToolError {
  const { status, method, path, siteUrl } = input;
  const body = asRecord(input.body);
  const errorText = str(body.error);
  const bodyCode = str(body.code);
  const message = str(body.message) || errorText;
  const where = `${method} ${path}`;

  // Auth failures, regardless of which route produced them.
  if (errorText === "key_revoked" || /api key was revoked/i.test(message)) {
    return new ToolError("key_revoked", "This API key was revoked. Create a new key in the lnkdrp dashboard.", { status });
  }
  if (errorText === "unauthorized" || /invalid api key/i.test(message) || status === 401) {
    return new ToolError("unauthorized", "The API key was not accepted by lnkdrp.", { status });
  }
  if (errorText === "forbidden" || /api key is read-only/i.test(message) || status === 403) {
    return new ToolError("forbidden", message || "This API key is not allowed to do that (read-only key or insufficient role).", {
      status,
    });
  }

  switch (status) {
    case 404:
      return new ToolError("not_found", "No such document in this workspace.", { status });
    case 400: {
      if (FETCH_BLOCKED_RE.test(errorText)) {
        return new ToolError("fetch_blocked", `lnkdrp could not fetch the source URL: ${errorText}`, { status, details: { error: errorText } });
      }
      if (TOO_LARGE_RE.test(errorText)) {
        return new ToolError("too_large", errorText, { status });
      }
      return new ToolError("validation", message || `lnkdrp rejected the request (${where}).`, {
        status,
        details: bodyCode ? { code: bodyCode } : undefined,
      });
    }
    case 402: {
      if (bodyCode === "plan_limit") {
        const upgradeUrl = `${siteUrl}/pricing`;
        // Usage caps carry a positive `max`; feature gates (Pro-only) come back with `max: 0`.
        const max = typeof body.max === "number" && body.max > 0 ? body.max : null;
        const cap = max !== null ? ` The Free plan allows ${max} for "${str(body.limit)}".` : "";
        return new ToolError("plan_limit", `${message || "Plan limit reached."}${cap} Upgrade at ${upgradeUrl} to lift the cap.`, {
          status,
          details: { ...body, upgradeUrl },
        });
      }
      return new ToolError("out_of_credits", message || "This workspace is out of AI credits.", {
        status,
        details: bodyCode ? { code: bodyCode } : undefined,
      });
    }
    case 413:
      return new ToolError("too_large", message || "The file is too large.", { status });
    case 415:
      return new ToolError("unsupported_content_type", message || "Only PDF files are supported.", {
        status,
        details: bodyCode ? { code: bodyCode } : undefined,
      });
    case 429:
      return new ToolError("rate_limited", message || "Too many requests; slow down and retry.", { status });
    default:
      return new ToolError("upstream", `lnkdrp API ${where} failed with ${status}${errorText ? `: ${errorText}` : ""}.`, {
        status,
        details: { status, ...(errorText ? { error: errorText } : {}) },
      });
  }
}

/** Success envelope: JSON text plus `structuredContent`. */
export function toolResult<T extends Record<string, unknown>>(result: T): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
}

/** Error envelope. Unknown errors are logged (without secrets) and reported as `upstream`. */
export function toolErrorResult(err: unknown): CallToolResult {
  const toolErr = isToolError(err)
    ? err
    : new ToolError("upstream", err instanceof Error ? err.message : "Unexpected error in the MCP server.");
  if (!isToolError(err)) log("unexpected tool error", err instanceof Error ? (err.stack ?? err.message) : err);
  const payload = { error: { code: toolErr.code, message: toolErr.message, ...(toolErr.details ? { details: toolErr.details } : {}) } };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/** Wrap a tool body so thrown errors become the error envelope instead of protocol errors. */
export function handleTool<A, E>(
  fn: (args: A, extra: E) => Promise<Record<string, unknown>>,
): (args: A, extra: E) => Promise<CallToolResult> {
  return async (args, extra) => {
    try {
      return toolResult(await fn(args, extra));
    } catch (err) {
      return toolErrorResult(err);
    }
  };
}
