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
/**
 * Things a workspace can still do on its current plan, given the limit it just hit.
 *
 * Written as instructions to an agent, because that is who reads them: each line names a tool call
 * or an action that will actually succeed right now. A refusal whose only suggestion is "pay" is a
 * dead end for an agent working on someone else's behalf — it cannot buy anything, and it stops.
 */
function planLimitAlternatives(limit: string): string[] {
  switch (limit) {
    case "documents":
      return [
        "add another share link to a document this workspace already has (lnkdrp_create_share_link — links are unlimited on every plan, one per investor or counterparty)",
        "replace the file on an existing document so recipients see the new version on the links they already have",
        "find one to archive with lnkdrp_list_docs, then archive it with lnkdrp_archive_doc — it frees a slot and keeps its analytics",
      ];
    case "projects":
      return ["put the document in an existing project", "archive a finished project to free the slot"];
    case "collaborators":
      return ["share a link with them instead of adding them to the workspace — recipients never need an account"];
    case "version_history":
      return [
        "replace the file anyway: the new version is recorded and every existing link serves it",
        "read the version history yourself (the owner's history page is not Pro-gated; only letting recipients browse versions is)",
      ];
    case "analytics_history":
      return [
        "read the basic figures, which every plan gets: views, downloads, pages viewed, total time and a unique viewer count",
        "narrow to one link with lnkdrp_get_share_stats and a shareId — per-link totals are not Pro-gated",
      ];
    default:
      return [];
  }
}

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

/** A finite number or null. */
function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * `out_of_credits` for a 402 that is not a plan limit. `DAILY_CREDIT_CAP` (Free daily brake) and
 * `OUT_OF_CREDITS` (balance exhausted) get different messages; `creditsNeeded`, `creditsRemaining`
 * and a reset date are included when the API body carries them.
 */
function outOfCreditsError(status: number, body: Record<string, unknown>, bodyCode: string, siteUrl: string): ToolError {
  const dailyCap = bodyCode === "DAILY_CREDIT_CAP";
  const creditsNeeded = numOrNull(body.creditsNeeded);
  const creditsRemaining = numOrNull(body.creditsRemaining);
  const resetAt = str(body.resetAt) || str(body.creditsResetAt) || str(body.resetsAt) || str(body.nextResetAt) || str(body.cycleEnd) || null;
  const parts = [dailyCap ? "Daily AI credit cap reached for this workspace." : "This workspace is out of AI credits."];
  if (creditsNeeded !== null) parts.push(`Needs ${creditsNeeded} credit${creditsNeeded === 1 ? "" : "s"}.`);
  if (creditsRemaining !== null) parts.push(`${creditsRemaining} remaining.`);
  if (resetAt) parts.push(`${dailyCap ? "The cap resets" : "Credits reset"} at ${resetAt}.`);
  parts.push(
    dailyCap
      ? "Retry after the reset, or pass summary and keyPoints to lnkdrp_share_pdf to share without credits."
      : `Pass summary and keyPoints to lnkdrp_share_pdf to share without credits, or add credits at ${siteUrl}/pricing.`,
  );
  return new ToolError("out_of_credits", parts.join(" "), {
    status,
    details: {
      ...(bodyCode ? { code: bodyCode } : {}),
      reason: dailyCap ? "daily_cap" : "exhausted",
      ...(creditsNeeded !== null ? { creditsNeeded } : {}),
      ...(creditsRemaining !== null ? { creditsRemaining } : {}),
      ...(resetAt ? { resetAt } : {}),
    },
  });
}

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
      if (bodyCode === "invalid_summary") {
        return new ToolError(
          "validation",
          `lnkdrp rejected summary/keyPoints: ${(message || "invalid summary").replace(/\.+$/, "")}. Fix and retry: summary must be 40-600 characters of ` +
            "plain text and keyPoints 2-7 items of at most 160 characters each, written from the document, with no URLs or " +
            "markup (they are stripped before the length check). Pass both or neither; omit both to let lnkdrp summarize (costs credits).",
          { status, details: { code: bodyCode } },
        );
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
        // What the caller can still do, not only what it cannot. An agent that hits a cap and is
        // told "upgrade" has one move and it costs the user money; most of the time there is a
        // free way to finish the job — another link on an existing document, an archive to free a
        // slot — and the agent cannot know that unless the refusal says so.
        const alternatives = planLimitAlternatives(str(body.limit));
        const alsoCan = alternatives.length ? ` Without upgrading you can still: ${alternatives.join("; ")}.` : "";
        return new ToolError(
          "plan_limit",
          `${message || "Plan limit reached."}${cap}${alsoCan} To lift the cap, the workspace owner can upgrade at ${upgradeUrl}.`,
          {
            status,
            // Both in `details` for a client that reads structure, and in the message above for one
            // that only shows text.
            details: { ...body, upgradeUrl, alternatives },
          },
        );
      }
      return outOfCreditsError(status, body, bodyCode, siteUrl);
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
