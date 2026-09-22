/**
 * API route: `/api/share/:shareId/download-requests/:token/approve`
 *
 * Token-based approval link intended to be clicked from the owner's email.
 * On approval, we email the requester a claim link (`/download/:token`) which requires sign-in.
 *
 * GET renders the decision; POST makes it. That split is the whole point of this file's shape.
 * The link ships to the owner's mailbox as plain text (see `downloadRequestOwnerEmail`), and
 * corporate mail security — Safe Links, Proofpoint, Mimecast — fetches every URL in a message
 * before the human ever opens it. While approving was a GET side effect, one of those scans
 * approved the download for the owner: it minted the claim token, flipped the row and emailed the
 * requester, with nobody having clicked anything. The emailed URL is unchanged, so every link
 * already in a mailbox keeps working; only the write moved behind a form submit, which a scanner
 * does not perform.
 */
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { ShareDownloadRequestModel } from "@/lib/models/ShareDownloadRequest";
import { sendEmailContent } from "@/lib/email/sendTextEmail";
import { downloadRequestApprovedEmail } from "@/lib/email/templates";
import { workspaceForEmail } from "@/lib/email/workspaceIdentity";
import { getPublicSiteBase } from "@/lib/urls";
import { recordActivity } from "@/lib/activity/log";

export const runtime = "nodejs";

/** Bound into the confirmation HMAC so an approve confirmation cannot be replayed at `/deny`. */
const CONFIRM_ACTION = "approve";
const CONFIRM_FIELD = "confirm";

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
 * deny route. It is deterministic on purpose — there is no server-side nonce store, and the token
 * itself is the capability, so a value that survives a page reload costs nothing extra.
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
      a { color: #fff; }
      code { background: rgba(0,0,0,.35); padding: 2px 6px; border-radius: 8px; }
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/** Mask an email for the activity feed: first char + domain (`c***@example.com`). */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email.charAt(0)}***@${email.slice(at + 1)}`;
}

type RequestRow = {
  _id: unknown;
  status?: unknown;
  requesterEmail?: unknown;
  docId?: unknown;
  ownerUserId?: unknown;
  claimTokenHash?: unknown;
};

/** The one read both handlers share: the request row this emailed token points at. */
async function findRequestRow(shareId: string, requestTokenHash: string): Promise<RequestRow | null> {
  const row = await ShareDownloadRequestModel.findOne({ shareId, requestTokenHash })
    .select({ _id: 1, status: 1, requesterEmail: 1, docId: 1, ownerUserId: 1, claimTokenHash: 1, approvedAt: 1, deniedAt: 1 })
    .lean();
  return (row as RequestRow | null) ?? null;
}

/** One doc read for the title shown on the confirmation card and written to the activity row. */
async function findDoc(docId: unknown): Promise<{ title?: unknown; orgId?: unknown } | null> {
  if (!docId) return null;
  // `shareId` now belongs to a link, not to the document (a document owns many links), so it is no
  // longer a field on the doc. The request row was already matched on `{ shareId, requestTokenHash }`,
  // which is what ties this token to that link; the doc is fetched by its own id.
  const doc = await DocModel.findOne({ _id: docId, isDeleted: { $ne: true } })
    .select({ title: 1, orgId: 1 })
    .lean()
    .catch(() => null);
  return (doc as { title?: unknown; orgId?: unknown } | null) ?? null;
}

/** A deleted or unreadable doc still gets a name, so the card never says "undefined". */
function docTitle(doc: { title?: unknown } | null): string {
  return typeof doc?.title === "string" && doc.title ? doc.title : "Shared document";
}

/**
 * The way back out of an approval, spelled on every card that reports one.
 *
 * Approving used to be the one decision here that could not be taken back, so an owner who hit the
 * wrong button had no lever short of disabling the link for everybody. The sibling deny route now
 * revokes an approval and kills the claim link with it — but only if the owner knows that, and the
 * only place they will be looking is this page. No URL is built for it: the deny link is one line
 * below the approve link in the same message (`downloadRequestOwnerEmail`), and naming the mail is
 * more robust than this route guessing how it is proxied.
 */
const UNDO_NOTE =
  `<div class="muted" style="margin-top:10px;">Approved by mistake? The “Deny” link in the same email takes it back and stops the claim link working.</div>`;

/** Terminal states render the same card on GET and POST, so a second click never re-approves. */
function settledPage(row: RequestRow): Response | null {
  const status = row.status;
  if (status === "denied") {
    return htmlPage("Already denied", `<div style="font-weight:700;">Already denied</div><div class="muted" style="margin-top:10px;">This request has already been denied.</div>`);
  }
  // If already approved, don't regenerate token. (We may still show a confirmation.)
  if (status === "approved" && typeof row.claimTokenHash === "string") {
    return htmlPage(
      "Already approved",
      `<div style="font-weight:700;">Already approved</div><div class="muted" style="margin-top:10px;">The requester has already been emailed a claim link.</div>${UNDO_NOTE}`,
    );
  }
  return null;
}

/**
 * The read-only card a GET lands on: who asked, for what, and a single button that POSTs back to
 * this same URL. Posting to "" keeps the form on the current path without the route having to know
 * how it is proxied.
 */
function confirmPage(args: { title: string; requesterEmail: string; requestTokenHash: string; note?: string }): Response {
  const note = args.note
    ? `<div class="muted" style="margin-top:10px;">${escapeHtml(args.note)}</div>`
    : "";
  return htmlPage(
    "Approve download",
    `<div style="font-weight:700;">Approve this download?</div>
      <div class="muted" style="margin-top:10px;">${escapeHtml(args.requesterEmail || "A recipient")} asked to download <strong>${escapeHtml(args.title)}</strong>.</div>
      <div class="muted" style="margin-top:10px;">They will be emailed a link that needs a sign-in to this email address.</div>
      ${note}
      <form method="post" action="">
        <input type="hidden" name="${CONFIRM_FIELD}" value="${escapeHtml(confirmValue(args.requestTokenHash))}" />
        <button type="submit">Approve download</button>
      </form>`,
    { status: args.note ? 400 : 200 },
  );
}

/** Same card for an unknown token and a deleted request: the link tells the holder nothing new. */
function notFoundPage(): Response {
  return htmlPage("Not found", `<div style="font-weight:700;">Request not found</div><div class="muted" style="margin-top:10px;">This approval link is invalid or expired.</div>`);
}

/** Read-only: show the owner what they are about to approve. Nothing here writes. */
export async function GET(_request: Request, ctx: { params: Promise<{ shareId: string; token: string }> }) {
  const { shareId, token } = await ctx.params;
  if (!shareId || !token) return NextResponse.json({ error: "Missing params" }, { status: 400 });

  await connectMongo();
  const requestTokenHash = sha256Hex(token);
  const reqDoc = await findRequestRow(shareId, requestTokenHash);
  if (!reqDoc) return notFoundPage();

  const settled = settledPage(reqDoc);
  if (settled) return settled;

  const doc = await findDoc(reqDoc.docId);
  const requesterEmail = typeof reqDoc.requesterEmail === "string" ? reqDoc.requesterEmail.trim().toLowerCase() : "";
  return confirmPage({ title: docTitle(doc), requesterEmail, requestTokenHash });
}

/** The write: mint the claim token, flip the row, log activity, email the requester. */
export async function POST(request: Request, ctx: { params: Promise<{ shareId: string; token: string }> }) {
  const { shareId, token } = await ctx.params;
  if (!shareId || !token) return NextResponse.json({ error: "Missing params" }, { status: 400 });

  await connectMongo();
  const requestTokenHash = sha256Hex(token);
  const reqDoc = await findRequestRow(shareId, requestTokenHash);
  if (!reqDoc) return notFoundPage();

  const settled = settledPage(reqDoc);
  if (settled) return settled;

  const requesterEmail = typeof reqDoc.requesterEmail === "string" ? reqDoc.requesterEmail.trim().toLowerCase() : "";
  const doc = await findDoc(reqDoc.docId);
  const title = docTitle(doc);

  const supplied = await readConfirmField(request);
  if (!confirmMatches(supplied, requestTokenHash)) {
    // Degrade rather than refuse: an owner whose browser dropped the field (a stale tab, a proxy
    // that strips form bodies) gets the card back with a working button instead of a dead end.
    return confirmPage({
      title,
      requesterEmail,
      requestTokenHash,
      note: "Confirmation was missing, so nothing has changed yet. Press the button to approve.",
    });
  }

  const claimToken = crypto.randomBytes(24).toString("base64url");
  const claimTokenHash = sha256Hex(claimToken);
  const now = new Date();

  // Approve atomically if still pending.
  const updateRes = await ShareDownloadRequestModel.updateOne(
    { _id: reqDoc._id, status: "pending" },
    { $set: { status: "approved", approvedAt: now, claimTokenHash, claimEmailError: null } },
  );

  if (updateRes.modifiedCount !== 1) {
    // Another click/race: treat as already handled.
    return htmlPage(
      "Already handled",
      `<div style="font-weight:700;">Already handled</div><div class="muted" style="margin-top:10px;">This request was updated in another session.</div>`,
    );
  }

  const to = requesterEmail;
  const base = getPublicSiteBase();
  const claimUrl = base ? new URL(`/download/${encodeURIComponent(claimToken)}`, base).toString() : "";

  // Activity (best-effort): the owner acted via an emailed capability link, so `actorKind` is "secret".
  const docOrgId = doc?.orgId;
  if (docOrgId) {
    void recordActivity({
      orgId: String(docOrgId),
      userId: reqDoc.ownerUserId ? String(reqDoc.ownerUserId) : null,
      actorKind: "secret",
      type: "download_request.approved",
      docId: reqDoc.docId ? String(reqDoc.docId) : null,
      title,
      meta: { email: maskEmail(to), shareId, requestId: String(reqDoc._id) },
      request,
    });
  }

  if (to) {
    try {
      await sendEmailContent({
        to,
        ...downloadRequestApprovedEmail({ title, claimUrl, workspace: await workspaceForEmail(doc?.orgId ? String(doc.orgId) : null) }),
      });
      await ShareDownloadRequestModel.updateOne(
        { _id: reqDoc._id },
        { $set: { claimEmailSentAt: new Date(), claimEmailError: null } },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to send requester email";
      await ShareDownloadRequestModel.updateOne(
        { _id: reqDoc._id },
        { $set: { claimEmailError: msg } },
      ).catch(() => void 0);
    }
  }

  return htmlPage(
    "Approved",
    `<div style="font-weight:700;">Approved</div><div class="muted" style="margin-top:10px;">The requester will receive an email with a link to download or save this document.</div>${UNDO_NOTE}`,
  );
}
