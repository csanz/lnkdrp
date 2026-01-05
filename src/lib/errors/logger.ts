import crypto from "node:crypto";
import { debugLog } from "@/lib/debug";
import { connectMongo } from "@/lib/mongodb";
import { ErrorEventModel } from "@/lib/models/ErrorEvent";
import type { ErrorCategory, ErrorSeverity } from "@/lib/errors/types";
import { Types } from "mongoose";

export type { ErrorCategory, ErrorSeverity } from "@/lib/errors/types";

export const ERROR_CODE_UNHANDLED_EXCEPTION = "UNHANDLED_EXCEPTION";
export const ERROR_CODE_CRON_JOB_FAILED = "CRON_JOB_FAILED";
export const ERROR_CODE_WORKER_TASK_FAILED = "WORKER_TASK_FAILED";
export const ERROR_CODE_STRIPE_WEBHOOK_INVALID_SIGNATURE = "STRIPE_WEBHOOK_INVALID_SIGNATURE";
export const ERROR_CODE_STRIPE_WEBHOOK_PROCESSING_FAILED = "STRIPE_WEBHOOK_PROCESSING_FAILED";

type LogContextIds = {
  requestId?: string | null;
  workspaceId?: string | null;
  userId?: string | null;
  uploadId?: string | null;
  docId?: string | null;
  runId?: string | null;
  model?: string | null;
};

export type LogErrorEventInput = {
  severity: ErrorSeverity;
  category: ErrorCategory;
  code: string;
  message?: string;
  err?: unknown;

  request?: Request;
  route?: string | null;
  method?: string | null;
  statusCode?: number | null;

  ids?: LogContextIds;
  meta?: unknown;
};

type ErrorLoggingConfig = {
  enabled: boolean;
  minSeverity: ErrorSeverity;
  ttlDays: number;
  allowedEnvs: string[] | null;
  currentEnv: string;
  sampleRateBySeverity: Record<ErrorSeverity, number>;
  captureStackBySeverity: Record<ErrorSeverity, boolean>;
  captureMeta: boolean;
  maxStackChars: number;
  maxMessageChars: number;
  maxMetaChars: number;
};

function parseBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v !== 0 : null;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1" || s === "yes" || s === "y") return true;
    if (s === "false" || s === "0" || s === "no" || s === "n") return false;
  }
  return null;
}

function parseFloat01(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function parsePositiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
}

function parseSeverity(v: unknown): ErrorSeverity | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (s === "error" || s === "warn" || s === "info") return s;
  return null;
}

function severityRank(s: ErrorSeverity): number {
  return s === "error" ? 3 : s === "warn" ? 2 : 1;
}

function envLabel(): string {
  return (process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "").trim().toLowerCase() || "unknown";
}

function parseCsvLower(v: unknown): string[] | null {
  if (typeof v !== "string") return null;
  const items = v
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return items.length ? Array.from(new Set(items)) : null;
}

function defaultAllowedEnvsForCurrent(currentEnv: string): string[] {
  if (currentEnv === "production") return ["production"];
  if (currentEnv === "development") return ["development"];
  // Default: preview is disallowed unless explicitly included.
  return [];
}

function readConfig(): ErrorLoggingConfig {
  const nodeEnv = (process.env.NODE_ENV ?? "").trim().toLowerCase();
  const vercelEnv = (process.env.VERCEL_ENV ?? "").trim().toLowerCase();
  const isDev = nodeEnv === "development";
  const isProdLike = nodeEnv === "production" || vercelEnv === "production";
  const currentEnv = envLabel();
  const allowedEnvs = parseCsvLower(process.env.ERROR_LOGGING_ALLOWED_ENVS);
  const allowed = allowedEnvs ?? defaultAllowedEnvsForCurrent(currentEnv);
  const envAllowed = allowed.includes(currentEnv);

  const enabledRaw = parseBool(process.env.ERROR_LOGGING_ENABLED);
  const enabled = enabledRaw ?? (isDev ? true : false);
  const enabledSafe = (isProdLike ? Boolean(enabledRaw) : enabled) && envAllowed;

  const minSeverity = parseSeverity(process.env.ERROR_LOGGING_MIN_SEVERITY) ?? "error";

  const sampleRateOverride = parseFloat01(process.env.ERROR_LOGGING_SAMPLE_RATE);
  const sampleRateBySeverity: Record<ErrorSeverity, number> = {
    error: sampleRateOverride ?? 1.0,
    warn: sampleRateOverride ?? 0.25,
    info: sampleRateOverride ?? 0.0,
  };

  const captureStackOverride = parseBool(process.env.ERROR_LOGGING_CAPTURE_STACK);
  const captureStackBySeverity: Record<ErrorSeverity, boolean> = {
    error: captureStackOverride ?? true,
    warn: captureStackOverride ?? false,
    info: captureStackOverride ?? false,
  };

  const captureMeta = parseBool(process.env.ERROR_LOGGING_CAPTURE_META) ?? true;

  const ttlDays = parsePositiveInt(process.env.ERROR_LOGGING_TTL_DAYS) ?? 14;
  const maxStackChars = parsePositiveInt(process.env.ERROR_LOGGING_MAX_STACK_CHARS) ?? 8000;
  const maxMessageChars = parsePositiveInt(process.env.ERROR_LOGGING_MAX_MESSAGE_CHARS) ?? 1000;
  const maxMetaChars = parsePositiveInt(process.env.ERROR_LOGGING_MAX_META_CHARS) ?? 8000;

  return {
    enabled: enabledSafe,
    minSeverity,
    ttlDays,
    allowedEnvs,
    currentEnv,
    sampleRateBySeverity,
    captureStackBySeverity,
    captureMeta,
    maxStackChars,
    maxMessageChars,
    maxMetaChars,
  };
}

/**
 * Returns true when MongoDB error event logging is enabled by env policy.
 *
 * Safe-by-default:
 * - In production-like envs, logging is disabled unless `ERROR_LOGGING_ENABLED=true`.
 * - In dev, defaults to enabled (unless explicitly set false).
 */
export function isErrorLoggingEnabled(): boolean {
  return readConfig().enabled;
}

/** Decide whether we should log at a given severity (min severity + sampling). */
export function shouldLogErrorEvent(severity: ErrorSeverity): boolean {
  const cfg = readConfig();
  if (!cfg.enabled) return false;
  if (severityRank(severity) < severityRank(cfg.minSeverity)) return false;
  const rate = cfg.sampleRateBySeverity[severity] ?? 0;
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return Math.random() < rate;
}

const SENSITIVE_KEYS = [
  "authorization",
  "cookie",
  "set-cookie",
  "token",
  "refresh",
  "password",
  "secret",
  "email",
  "phone",
  "address",
  "ip",
  "ssn",
  "dob",
  "apikey",
  "api_key",
  "x-api-key",
  "client_secret",
  "stripesignature",
  "stripe-signature",
];

function looksLikeJwt(s: string): boolean {
  const t = s.trim();
  // Very loose JWT heuristic: three dot-separated base64url-ish parts.
  if (t.length < 30) return false;
  if (t.split(".").length !== 3) return false;
  return /^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/.test(t);
}

function redactString(s: string): string {
  const t = s.trim();
  if (!t) return s;
  if (looksLikeJwt(t)) return "[REDACTED_JWT]";
  if (/^bearer\s+[A-Za-z0-9\-_\.=]+$/i.test(t) && t.length > 20) return "[REDACTED_BEARER]";
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(t)) return "[REDACTED_EMAIL]";
  return s;
}

function isSensitiveKey(k: string): boolean {
  const key = (k ?? "").trim().toLowerCase();
  if (!key) return false;
  return SENSITIVE_KEYS.some((sk) => key === sk || key.includes(sk));
}

function truncate(s: string, maxChars: number): string {
  if (typeof s !== "string") return "";
  if (maxChars <= 0) return "";
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 12))}…[truncated]`;
}

function sanitizeUnknown(
  input: unknown,
  opts: { maxDepth: number; maxArray: number; maxKeys: number; maxString: number },
): unknown {
  if (input == null) return input;

  // Primitive
  if (typeof input === "string") return truncate(redactString(input), opts.maxString);
  if (typeof input === "number" || typeof input === "boolean") return input;
  if (typeof input === "bigint") return String(input);

  // Errors
  if (input instanceof Error) {
    return {
      name: truncate(input.name ?? "Error", opts.maxString),
      message: truncate(redactString(input.message ?? ""), opts.maxString),
      // Never include stacks here; stack capture is controlled separately.
      ...(input.cause ? { cause: sanitizeUnknown(input.cause, { ...opts, maxDepth: Math.max(0, opts.maxDepth - 1) }) } : {}),
    };
  }

  // Buffers / binary-ish
  const asAny = input as any;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(input)) return "[REDACTED_BINARY]";
  if (asAny && typeof asAny === "object" && (asAny instanceof ArrayBuffer || ArrayBuffer.isView?.(asAny))) return "[REDACTED_BINARY]";

  if (opts.maxDepth <= 0) return "[TRUNCATED_DEPTH]";

  // Arrays
  if (Array.isArray(input)) {
    const out: unknown[] = [];
    const max = Math.max(0, opts.maxArray);
    for (let i = 0; i < input.length && i < max; i += 1) {
      out.push(sanitizeUnknown(input[i], { ...opts, maxDepth: opts.maxDepth - 1 }));
    }
    if (input.length > max) out.push(`[TRUNCATED_ARRAY:${input.length - max}]`);
    return out;
  }

  // Objects
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const keys = Object.keys(obj);
    const maxKeys = Math.max(0, opts.maxKeys);
    const out: Record<string, unknown> = {};
    for (let i = 0; i < keys.length && i < maxKeys; i += 1) {
      const k = keys[i]!;
      if (isSensitiveKey(k)) continue;
      const v = obj[k];
      out[k] = sanitizeUnknown(v, { ...opts, maxDepth: opts.maxDepth - 1 });
    }
    if (keys.length > maxKeys) out._truncatedKeys = keys.length - maxKeys;
    return out;
  }

  return String(input);
}

/**
 * Sanitize a meta payload for safe storage.
 *
 * This:
 * - removes sensitive keys
 * - redacts JWTs / bearer-like strings
 * - bounds recursion depth, array length, key count, and string length
 */
export function sanitizeMeta(input: unknown): unknown {
  return sanitizeUnknown(input, { maxDepth: 5, maxArray: 30, maxKeys: 50, maxString: 500 });
}

const FINGERPRINT_HEX_LEN = 32;

function firstStackLine(stack: string | null): string {
  if (typeof stack !== "string") return "";
  return stack
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)[0] ?? "";
}

function normalizeFingerprintPart(s: string): string {
  return (s ?? "").trim().replace(/\s+/g, " ");
}

/**
 * Build a stable fingerprint for grouping similar errors.
 *
 * Inputs:
 * - code + category + route
 * - plus: first stack line when available, otherwise message prefix
 *
 * Output:
 * - stable-length hex string (sha256 truncated)
 */
export function buildFingerprint(args: {
  code: string;
  category: ErrorCategory;
  route?: string | null;
  stack?: string | null;
  message?: string | null;
}): string {
  const code = normalizeFingerprintPart(args.code || "UNKNOWN_CODE");
  const category = normalizeFingerprintPart(args.category || "unknown");
  const route = normalizeFingerprintPart(args.route ?? "");

  const stackSig = normalizeFingerprintPart(firstStackLine(args.stack ?? null));
  const msgSig = normalizeFingerprintPart((args.message ?? "").slice(0, 120));
  const sig = stackSig || msgSig;

  const base = [code, category, route, sig].filter(Boolean).join("|");
  const hex = crypto.createHash("sha256").update(base).digest("hex");
  return hex.slice(0, FINGERPRINT_HEX_LEN);
}

function requestMetaFromRequest(request?: Request): { route?: string; method?: string; requestId?: string | null } {
  if (!request) return {};
  try {
    const url = new URL(request.url);
    const route = url.pathname;
    const method = (request.method ?? "").trim().toUpperCase() || undefined;
    // Best-effort: only use explicit request id header if present.
    const requestId = request.headers.get("x-request-id")?.trim() ?? null;
    return { route, method, requestId };
  } catch {
    return {};
  }
}

/**
 * Best-effort persist a sanitized ErrorEvent into MongoDB.
 *
 * Safety rules:
 * - Never logs cookies/auth headers/tokens or raw request bodies.
 * - Truncates message/stack/meta to configured limits.
 * - Never throws; failures are swallowed.
 */
export async function logErrorEvent(input: LogErrorEventInput): Promise<void> {
  const cfg = readConfig();
  const severity = input.severity;
  if (!shouldLogErrorEvent(severity)) return;

  const reqMeta = requestMetaFromRequest(input.request);
  const route = (input.route ?? reqMeta.route ?? null) as string | null;
  const method = (input.method ?? reqMeta.method ?? null) as string | null;
  const requestId = (input.ids?.requestId ?? reqMeta.requestId ?? null) as string | null;

  const rawMessage =
    typeof input.message === "string" && input.message.trim()
      ? input.message
      : input.err instanceof Error
        ? input.err.message
        : input.err
          ? String(input.err)
          : "";
  const message = truncate(redactString(rawMessage || "Error"), cfg.maxMessageChars);

  const captureStack = cfg.captureStackBySeverity[severity] ?? false;
  const rawStack = captureStack && input.err instanceof Error ? input.err.stack ?? null : null;
  const stack = rawStack ? truncate(rawStack, cfg.maxStackChars) : null;

  const fingerprint = buildFingerprint({ code: input.code, category: input.category, route, stack, message });

  let meta: unknown = null;
  if (cfg.captureMeta && input.meta != null) {
    meta = sanitizeMeta(input.meta);
    try {
      const json = JSON.stringify(meta);
      if (json.length > cfg.maxMetaChars) {
        meta = { _truncated: true, preview: json.slice(0, cfg.maxMetaChars) };
      }
    } catch {
      meta = { _unstringifiable: true };
    }
  }

  // NOTE: never allow failures here to crash the request/job path.
  try {
    const asObjectIdOrNull = (v: string | null | undefined): Types.ObjectId | null => {
      const s = typeof v === "string" ? v.trim() : "";
      return s && Types.ObjectId.isValid(s) ? new Types.ObjectId(s) : null;
    };

    await connectMongo();
    await ErrorEventModel.create({
      createdAt: new Date(),
      env: envLabel(),
      severity,
      category: input.category,
      code: input.code,
      message,
      stack,
      route,
      method,
      statusCode: typeof input.statusCode === "number" ? input.statusCode : null,
      requestId,
      workspaceId: asObjectIdOrNull(input.ids?.workspaceId ?? null),
      userId: asObjectIdOrNull(input.ids?.userId ?? null),
      uploadId: asObjectIdOrNull(input.ids?.uploadId ?? null),
      docId: asObjectIdOrNull(input.ids?.docId ?? null),
      runId: asObjectIdOrNull(input.ids?.runId ?? null),
      model: input.ids?.model ? String(input.ids.model) : null,
      fingerprint,
      meta,
    });
    debugLog(2, "[error:event] logged", { severity, category: input.category, code: input.code, route });
  } catch (e) {
    debugLog(2, "[error:event] failed (swallowed)", { message: e instanceof Error ? e.message : String(e) });
  }
}


