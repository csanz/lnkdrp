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
 *
 * **Deny also revokes an approval.** It used to act on `pending` alone and answer "Already
 * approved" otherwise, which made an approval the one decision in this flow that could not be
 * taken back: an owner who fat-fingered Approve — or whose mail scanner did it for them, before
 * the GET/POST split above closed that — went back to the same message, clicked Deny, and was told
 * nothing could be done. The requester kept a claim link that re-downloads the PDF indefinitely
 * and can take a permanent copy through `/api/download/:token/save`, and the owner's only
 * remaining lever was disabling or archiving the whole share link, which cuts off every other
 * recipient it was created for. So an approved row can now be denied, and the write clears the
 * claim token as well as the status: `/api/download/:token{,/pdf,/save}` all match on
 * `{ claimTokenHash, status: "approved" }`, so either half alone is enough and both together
 * leave nothing for the emailed claim link to match. Only `denied` is terminal.
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

/**
 * The one terminal state, rendered the same on GET and POST so a second click never re-denies.
 *
 * `approved` used to be listed here too, which is what made an approval irreversible; it is now a
 * state this route can act on, and {@link denyMode} decides which card it gets.
 */
function settledPage(row: RequestRow): Response | null {
  if (row.status === "denied") {
    return htmlPage("Already denied", `<div style="font-weight:700;">Already denied</div><div class="muted" style="margin-top:10px;">This request has already been denied.</div>`);
  }
  return null;
}

/**
 * Which decision this row is asking for: denying a request nobody has answered, or taking back an
 * approval. Anything else (a row in a state a future migration adds) is not this route's to touch.
 */
type DenyMode = "deny" | "revoke";

function denyMode(row: RequestRow): DenyMode | null {
  if (row.status === "pending") return "deny";
  if (row.status === "approved") return "revoke";
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
 *
 * The revoke wording is not decoration. An owner arriving here after an approval needs to know
 * that the claim link already sitting in the requester's inbox is what stops working — that is the
 * thing they came back to undo, and it is the only part of the approval that is still live.
 */
function confirmPage(args: { mode: DenyMode; requesterEmail: string; requestTokenHash: string; note?: string }): Response {
  const note = args.note ? `<div class="muted" style="margin-top:10px;">${escapeHtml(args.note)}</div>` : "";
  const who = escapeHtml(args.requesterEmail || "A recipient");
  const heading = args.mode === "revoke" ? "Take back this approval?" : "Deny this download?";
  const lead =
    args.mode === "revoke"
      ? `${who} was approved to download this document.`
      : `${who} asked to download this document.`;
  const consequence =
    args.mode === "revoke"
      ? "The download link already emailed to them stops working. Denying is final, so they would have to ask again."
      : "Denying is final, so they would have to ask again.";
  return htmlPage(
    args.mode === "revoke" ? "Take back approval" : "Deny download",
    `<div style="font-weight:700;">${heading}</div>
      <div class="muted" style="margin-top:10px;">${lead}</div>
      <div class="muted" style="margin-top:10px;">${consequence}</div>
      ${note}
      <form method="post" action="">
        <input type="hidden" name="${CONFIRM_FIELD}" value="${escapeHtml(confirmValue(args.requestTokenHash))}" />
        <button type="submit">${args.mode === "revoke" ? "Take back approval" : "Deny download"}</button>
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

  const mode = denyMode(reqDoc);
  if (!mode) return notFoundPage();

  const requesterEmail = typeof reqDoc.requesterEmail === "string" ? reqDoc.requesterEmail : "";
  return confirmPage({ mode, requesterEmail, requestTokenHash });
}

/** The write: flip the row to denied, kill any claim token it handed out, and log the activity. */
export async function POST(request: Request, ctx: { params: Promise<{ shareId: string; token: string }> }) {
  const { shareId, token } = await ctx.params;
  if (!shareId || !token) return NextResponse.json({ error: "Missing params" }, { status: 400 });

  await connectMongo();
  const requestTokenHash = sha256Hex(token);
  const reqDoc = await findRequestRow(shareId, requestTokenHash);
  if (!reqDoc) return notFoundPage();

  const settled = settledPage(reqDoc);
  if (settled) return settled;

  const mode = denyMode(reqDoc);
  if (!mode) return notFoundPage();

  const requesterEmail = typeof reqDoc.requesterEmail === "string" ? reqDoc.requesterEmail : "";
  const supplied = await readConfirmField(request);
  if (!confirmMatches(supplied, requestTokenHash)) {
    // Degrade rather than refuse: an owner whose browser dropped the field gets the card back with
    // a working button instead of a dead end. Denial being irreversible, refusing here is cheap.
    return confirmPage({
      mode,
      requesterEmail,
      requestTokenHash,
      note: "Confirmation was missing, so nothing has changed yet. Press the button to confirm.",
    });
  }

  /**
   * One conditional update covers both modes, so a double submit — or an Approve landing between
   * this row being read and written — still produces exactly one decision.
   *
   * `claimTokenHash` is reset to the row's own `requestTokenHash` rather than `$unset`. That is the
   * unique placeholder the create route writes for exactly the reason it documents there: some
   * environments carry a non-sparse unique index on this field, where two rows with the value
   * missing collide as duplicate nulls. `requestTokenHash` is itself unique, so the placeholder
   * cannot collide, and no claim link can match it — the token in the requester's inbox hashes to
   * the value we are overwriting, and a caller who somehow held the *request* token would still be
   * turned away by the `status: "approved"` half of the claim routes' filter.
   */
  const updateRes = await ShareDownloadRequestModel.updateOne(
    { _id: reqDoc._id, status: mode === "revoke" ? "approved" : "pending" },
    { $set: { status: "denied", deniedAt: new Date(), claimTokenHash: requestTokenHash } },
  );
  if (updateRes.modifiedCount !== 1) {
    // Somebody else decided this row between the read above and the write. Say so rather than
    // reporting a denial that did not happen.
    return htmlPage(
      "Already handled",
      `<div style="font-weight:700;">Already handled</div><div class="muted" style="margin-top:10px;">This request was updated in another session.</div>`,
    );
  }

  // Activity (best-effort): one doc lookup for org + title; the owner acted via an emailed capability link.
  {
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
          // The row ends `denied` either way, so the feed's wording ("denied a download request
          // for …", `src/lib/activity/labels.ts`) stays true for both — but a revoke also killed a
          // claim link that was already out, and an owner reading the feed later needs that on the
          // record. The flag is the durable half; the label can learn to say "took back" from it.
          revokedApproval: mode === "revoke",
        },
        request,
      });
    }
  }

  return mode === "revoke"
    ? htmlPage(
        "Approval taken back",
        `<div style="font-weight:700;">Approval taken back</div><div class="muted" style="margin-top:10px;">This download request is now denied, and the download link already emailed to the requester no longer works.</div>`,
      )
    : htmlPage("Denied", `<div style="font-weight:700;">Denied</div><div class="muted" style="margin-top:10px;">This download request has been denied.</div>`);
}
