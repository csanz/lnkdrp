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

/**
 * Purpose label for the derived key. Changing either string rotates the key, which costs at most
 * one five-minute window of in-flight tokens, so they are versioned and left alone anyway.
 */
const PROCESS_KEY_SALT = "lnkdrp-internal-process";
const PROCESS_KEY_INFO = "internal-process-hmac:v1";

/**
 * The key these tokens are signed with.
 *
 * What went wrong: this returned `NEXTAUTH_SECRET` verbatim (or `CRON_SECRET`, which Vercel Cron
 * sends in an `Authorization` header and which therefore lands in request logs and proxy traces).
 * `NEXTAUTH_SECRET` is not an upload-processing secret — it is the fallback behind session cookies,
 * the AES key over every share password at rest (`src/lib/sharePassword.ts`), the AES key over org
 * invite tokens, view-notification tokens and this HMAC. Anything that learned the value used here
 * learned all of that, and everything this module legitimately needs is one HMAC key.
 *
 * Why the fix is shaped this way: same shape as `src/lib/realtime/ticket.ts` — never use the master
 * secret as a key, run it through HKDF with a fixed purpose label instead, so the value this module
 * holds is one-way separated from the input and is good for nothing but minting five-minute
 * `process:<uploadId>:<ts>` tokens. Derivation rather than a new required env var, because throwing
 * on a single-secret deploy would refuse where degrading is available: the monthly credit-floor
 * re-queue and the summary rerun hand-off both call this, and a throw turns a working deployment
 * into silently skipped summaries.
 *
 * No migration: these tokens live five minutes and nothing signed by this key is stored, so the
 * rotation costs at most one in-flight trigger during a deploy — and both callers already treat a
 * refused trigger as "not queued" rather than as data loss.
 */
function secret(): string {
  const base = (process.env.NEXTAUTH_SECRET || process.env.CRON_SECRET || "").trim();
  if (!base) throw new Error("NEXTAUTH_SECRET (or CRON_SECRET) is not set for internal process tokens");
  return Buffer.from(crypto.hkdfSync("sha256", base, PROCESS_KEY_SALT, PROCESS_KEY_INFO, 32)).toString("base64url");
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
