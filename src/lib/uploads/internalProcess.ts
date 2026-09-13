/**
 * Server-to-server trigger for upload processing.
 *
 * Some runs start without a browser session: the monthly credit floor re-queues skipped summaries,
 * and the summary rerun endpoint hands off to the processing route. They call
 * `POST /api/uploads/:id/process` with a short-lived HMAC token bound to the upload id; the route
 * then acts as the upload's owner in the document's workspace (billed like an owner upload, never
 * like a recipient upload).
 */
import crypto from "node:crypto";

export const INTERNAL_PROCESS_HEADER = "x-lnkdrp-internal-process";
const TOKEN_TTL_MS = 5 * 60 * 1000;

function secret(): string {
  const s = (process.env.NEXTAUTH_SECRET || process.env.CRON_SECRET || "").trim();
  if (!s) throw new Error("NEXTAUTH_SECRET is not set");
  return s;
}

function mac(uploadId: string, ts: number): string {
  return crypto.createHmac("sha256", secret()).update(`process:${uploadId}:${ts}`).digest("base64url");
}

/** Mint a token for `uploadId`, valid for five minutes. */
export function signInternalProcessToken(uploadId: string, now: number = Date.now()): string {
  return `${now}.${mac(uploadId, now)}`;
}

/** True when `token` was minted for `uploadId` by this server within the last five minutes. */
export function verifyInternalProcessToken(uploadId: string, token: string | null | undefined, now: number = Date.now()): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const ts = Number(token.slice(0, dot));
  if (!Number.isFinite(ts) || ts > now + 30_000 || now - ts > TOKEN_TTL_MS) return false;
  let expected: string;
  try {
    expected = mac(uploadId, ts);
  } catch {
    return false;
  }
  const a = Buffer.from(token.slice(dot + 1));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Fire the processing route for `uploadId` as the server. Resolves once the route accepted the job. */
export async function triggerUploadProcessing(params: { origin: string; uploadId: string }): Promise<boolean> {
  const res = await fetch(`${params.origin.replace(/\/+$/, "")}/api/uploads/${encodeURIComponent(params.uploadId)}/process`, {
    method: "POST",
    headers: { [INTERNAL_PROCESS_HEADER]: signInternalProcessToken(params.uploadId) },
  });
  return res.ok;
}
