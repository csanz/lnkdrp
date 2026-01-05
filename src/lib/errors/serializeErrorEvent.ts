import { sanitizeMeta } from "@/lib/errors/logger";

const SENSITIVE_KEYS = [
  "authorization",
  "cookie",
  "set-cookie",
  "token",
  "refresh",
  "password",
  "secret",
  "apikey",
  "api_key",
  "x-api-key",
  "client_secret",
  "stripesignature",
  "stripe-signature",
];

function isSensitiveKey(k: string): boolean {
  const key = (k ?? "").trim().toLowerCase();
  if (!key) return false;
  return SENSITIVE_KEYS.some((sk) => key === sk || key.includes(sk));
}

function stripSensitiveKeys(input: unknown, maxDepth = 6): unknown {
  if (input == null) return input;
  if (maxDepth <= 0) return "[TRUNCATED_DEPTH]";
  if (Array.isArray(input)) return input.map((v) => stripSensitiveKeys(v, maxDepth - 1));
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) {
      if (isSensitiveKey(k)) continue;
      out[k] = stripSensitiveKeys(obj[k], maxDepth - 1);
    }
    return out;
  }
  return input;
}

/**
 * Defense-in-depth serializer for admin responses.
 *
 * Even though ErrorEvent meta is sanitized before storage, this re-sanitizes and
 * strips sensitive keys again to prevent accidental exposure if older/bad data exists.
 */
export function serializeErrorEventForAdmin(doc: any) {
  const metaSanitized = sanitizeMeta(doc?.meta ?? null);
  const meta = stripSensitiveKeys(metaSanitized);
  return {
    id: doc?._id ? String(doc._id) : String(doc?.id ?? ""),
    createdAt: doc?.createdAt instanceof Date ? doc.createdAt.toISOString() : doc?.createdAt ?? null,
    env: typeof doc?.env === "string" ? doc.env : null,
    severity: typeof doc?.severity === "string" ? doc.severity : null,
    category: typeof doc?.category === "string" ? doc.category : null,
    code: typeof doc?.code === "string" ? doc.code : null,
    message: typeof doc?.message === "string" ? doc.message : null,
    stack: typeof doc?.stack === "string" ? doc.stack : null,
    route: typeof doc?.route === "string" ? doc.route : null,
    method: typeof doc?.method === "string" ? doc.method : null,
    statusCode: typeof doc?.statusCode === "number" ? doc.statusCode : null,
    requestId: typeof doc?.requestId === "string" ? doc.requestId : null,
    workspaceId: doc?.workspaceId ? String(doc.workspaceId) : null,
    userId: doc?.userId ? String(doc.userId) : null,
    uploadId: doc?.uploadId ? String(doc.uploadId) : null,
    docId: doc?.docId ? String(doc.docId) : null,
    runId: doc?.runId ? String(doc.runId) : null,
    model: typeof doc?.model === "string" ? doc.model : null,
    fingerprint: typeof doc?.fingerprint === "string" ? doc.fingerprint : null,
    meta,
    lastSeenAt: doc?.lastSeenAt instanceof Date ? doc.lastSeenAt.toISOString() : doc?.lastSeenAt ?? null,
  };
}


