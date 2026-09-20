/**
 * API route: `/api/share/:shareId/download-requests/:token/deny`
 *
 * Token-based denial link intended to be clicked from the owner's email.
 * Currently records the denial; it does not email the requester.
 *
 * GET renders the decision; POST makes it. Denying used to happen in the GET, and the link sits in
 * the owner's mailbox as plain text next to the approve link (see `downloadRequestOwnerEmail`), so
 * any mail gateway that fetches URLs — Safe Links, Proofpoint, Mimecast — permanently denied a
 * legitimate request before the owner had read the message. Denial is one-way: the row leaves
 * `pending` and no later click can bring it back. The emailed URL is unchanged, so links already
 * in mailboxes keep working; only the write moved behind a form submit.
 */
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { ShareDownloadRequestModel } from "@/lib/models/ShareDownloadRequest";
import { recordActivity } from "@/lib/activity/log";

export const runtime = "nodejs";

/** Bound into the confirmation HMAC so a deny confirmation cannot be replayed at `/approve`. */
const CONFIRM_ACTION = "deny";
const CONFIRM_FIELD = "confirm";

/** Mask an email for the activity feed: first char + domain (`c***@example.com`). */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email.charAt(0)}***@${email.slice(at + 1)}`;
}

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/**
 * Secret behind the confirmation value. Mirrors `viewEmailToken.getTokenSecret`: a dev fallback so
 * local envs run, and a hard failure in production rather than signing with a key anyone can guess.
 */
function confirmSecret(): string {
  const s = process.env.LNKDRP_NOTIFICATION_TOKEN_SECRET || process.env.NEXTAUTH_SECRET || "";
  if (s) return s;
  if (process.env.NODE_ENV !== "production") return "dev-lnkdrp-notification-token-secret";
  throw new Error("Missing LNKDRP_NOTIFICATION_TOKEN_SECRET (or NEXTAUTH_SECRET) for download-request confirmations");
}

/**
 * Hidden field the confirmation form carries back.
 *
 * A scanner that merely follows links is already stopped by GET no longer writing; this stops the
 * rarer one that blindly POSTs to a URL it found. The value is an HMAC over the stored token hash
 * and the action word, so it cannot be derived from the emailed URL and is useless on the sibling
 * approve route.
 */
function confirmValue(requestTokenHash: string): string {
  return crypto
    .createHmac("sha256", confirmSecret())
    .update(`lnkdrp.download-request-confirm.v1:${CONFIRM_ACTION}:${requestTokenHash}`)
    .digest("base64url");
}

/** Constant-time compare that never throws: unequal lengths are simply unequal. */
function confirmMatches(supplied: string, requestTokenHash: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(confirmValue(requestTokenHash));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Read the confirmation field out of a form post; a body we cannot parse is simply not a confirmation. */
async function readConfirmField(request: Request): Promise<string> {
  try {
    const form = await request.formData();
    const value = form.get(CONFIRM_FIELD);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function htmlPage(title: string, body: string, init?: { status?: number }) {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { margin: 0; padding: 40px 18px; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; background:#050506; color:#fff; }
      .card { max-width: 560px; margin: 0 auto; padding: 22px 22px; border: 1px solid rgba(255,255,255,.12); border-radius: 18px; background: rgba(255,255,255,.06); }
      .muted { color: rgba(255,255,255,.65); }
      button { margin-top: 18px; padding: 10px 18px; border-radius: 999px; border: 1px solid rgba(255,255,255,.18); background:#fff; color:#050506; font: inherit; font-weight: 600; cursor: pointer; }
    </style>
  </head>
  <body>
    <div class="card">
      ${body}
    </div>
  </body>
</html>`;
  return new Response(html, {
    status: init?.status ?? 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

type RequestRow = {
  _id: unknown;
  status?: unknown;
  docId?: unknown;
  ownerUserId?: unknown;
  requesterEmail?: unknown;
};

/** The one read both handlers share: the request row this emailed token points at. */
async function findRequestRow(shareId: string, requestTokenHash: string): Promise<RequestRow | null> {
  const row = await ShareDownloadRequestModel.findOne({ shareId, requestTokenHash })
    .select({ _id: 1, status: 1, docId: 1, ownerUserId: 1, requesterEmail: 1 })
    .lean();
  return (row as RequestRow | null) ?? null;
}

/** Terminal states render the same card on GET and POST, so a second click never re-denies. */
function settledPage(row: RequestRow): Response | null {
  const status = row.status;
  if (status === "approved") {
    return htmlPage("Already approved", `<div style="font-weight:700;">Already approved</div><div class="muted" style="margin-top:10px;">This request was already approved.</div>`);
  }
  if (status === "denied") {
    return htmlPage("Already denied", `<div style="font-weight:700;">Already denied</div><div class="muted" style="margin-top:10px;">This request has already been denied.</div>`);
  }
  return null;
}

/** Same card for an unknown token and a deleted request: the link tells the holder nothing new. */
function notFoundPage(): Response {
  return htmlPage("Not found", `<div style="font-weight:700;">Request not found</div><div class="muted" style="margin-top:10px;">This denial link is invalid or expired.</div>`);
}

/**
 * The read-only card a GET lands on: who asked, and a single button that POSTs back to this same
 * URL. Posting to "" keeps the form on the current path without the route having to know how it is
 * proxied.
 */
function confirmPage(args: { requesterEmail: string; requestTokenHash: string; note?: string }): Response {
  const note = args.note ? `<div class="muted" style="margin-top:10px;">${escapeHtml(args.note)}</div>` : "";
  return htmlPage(
    "Deny download",
    `<div style="font-weight:700;">Deny this download?</div>
      <div class="muted" style="margin-top:10px;">${escapeHtml(args.requesterEmail || "A recipient")} asked to download this document.</div>
      <div class="muted" style="margin-top:10px;">Denying is final — they would have to ask again.</div>
      ${note}
      <form method="post" action="">
        <input type="hidden" name="${CONFIRM_FIELD}" value="${escapeHtml(confirmValue(args.requestTokenHash))}" />
        <button type="submit">Deny download</button>
      </form>`,
    { status: args.note ? 400 : 200 },
  );
}

/** Read-only: show the owner what they are about to deny. Nothing here writes. */
export async function GET(_request: Request, ctx: { params: Promise<{ shareId: string; token: string }> }) {
  const { shareId, token } = await ctx.params;
  if (!shareId || !token) return NextResponse.json({ error: "Missing params" }, { status: 400 });

  await connectMongo();
  const requestTokenHash = sha256Hex(token);
  const reqDoc = await findRequestRow(shareId, requestTokenHash);
  if (!reqDoc) return notFoundPage();

  const settled = settledPage(reqDoc);
  if (settled) return settled;

  const requesterEmail = typeof reqDoc.requesterEmail === "string" ? reqDoc.requesterEmail : "";
  return confirmPage({ requesterEmail, requestTokenHash });
}

/** The write: flip the row to denied and log the activity. */
export async function POST(request: Request, ctx: { params: Promise<{ shareId: string; token: string }> }) {
  const { shareId, token } = await ctx.params;
  if (!shareId || !token) return NextResponse.json({ error: "Missing params" }, { status: 400 });

  await connectMongo();
  const requestTokenHash = sha256Hex(token);
  const reqDoc = await findRequestRow(shareId, requestTokenHash);
  if (!reqDoc) return notFoundPage();

  const settled = settledPage(reqDoc);
  if (settled) return settled;

  const requesterEmail = typeof reqDoc.requesterEmail === "string" ? reqDoc.requesterEmail : "";
  const supplied = await readConfirmField(request);
  if (!confirmMatches(supplied, requestTokenHash)) {
    // Degrade rather than refuse: an owner whose browser dropped the field gets the card back with
    // a working button instead of a dead end. Denial being irreversible, refusing here is cheap.
    return confirmPage({
      requesterEmail,
      requestTokenHash,
      note: "Confirmation was missing, so nothing has changed yet. Press the button to deny.",
    });
  }

  const updateRes = await ShareDownloadRequestModel.updateOne(
    { _id: reqDoc._id, status: "pending" },
    { $set: { status: "denied", deniedAt: new Date() } },
  );

  // Activity (best-effort): one doc lookup for org + title; the owner acted via an emailed capability link.
  if (updateRes.modifiedCount === 1) {
    const docId = reqDoc.docId;
    const doc = docId
      ? await DocModel.findOne({ _id: docId }).select({ title: 1, orgId: 1 }).lean().catch(() => null)
      : null;
    const docOrgId = (doc as { orgId?: unknown } | null)?.orgId;
    if (docOrgId) {
      void recordActivity({
        orgId: String(docOrgId),
        userId: reqDoc.ownerUserId ? String(reqDoc.ownerUserId) : null,
        actorKind: "secret",
        type: "download_request.denied",
        docId: String(docId),
        title: typeof (doc as { title?: unknown } | null)?.title === "string" ? String((doc as { title: string }).title) : null,
        meta: {
          email: requesterEmail ? maskEmail(requesterEmail) : null,
          shareId,
          requestId: String(reqDoc._id),
        },
        request,
      });
    }
  }

  return htmlPage("Denied", `<div style="font-weight:700;">Denied</div><div class="muted" style="margin-top:10px;">This download request has been denied.</div>`);
}
