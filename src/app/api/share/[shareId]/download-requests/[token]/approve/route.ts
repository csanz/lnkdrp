/**
 * API route: GET `/api/share/:shareId/download-requests/:token/approve`
 *
 * Token-based approval link intended to be clicked from the owner's email.
 * On approval, we email the requester a claim link (`/download/:token`) which requires sign-in.
 */
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { ShareDownloadRequestModel } from "@/lib/models/ShareDownloadRequest";
import { sendTextEmail } from "@/lib/email/sendTextEmail";
import { getPublicSiteBase } from "@/lib/urls";

export const runtime = "nodejs";

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function htmlPage(title: string, body: string) {
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
    </style>
  </head>
  <body>
    <div class="card">
      ${body}
    </div>
  </body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

export async function GET(_request: Request, ctx: { params: Promise<{ shareId: string; token: string }> }) {
  const { shareId, token } = await ctx.params;
  if (!shareId || !token) return NextResponse.json({ error: "Missing params" }, { status: 400 });

  await connectMongo();
  const requestTokenHash = sha256Hex(token);
  const reqDoc = await ShareDownloadRequestModel.findOne({ shareId, requestTokenHash })
    .select({ _id: 1, status: 1, requesterEmail: 1, docId: 1, claimTokenHash: 1, approvedAt: 1, deniedAt: 1 })
    .lean();

  if (!reqDoc) {
    return htmlPage("Not found", `<div style="font-weight:700;">Request not found</div><div class="muted" style="margin-top:10px;">This approval link is invalid or expired.</div>`);
  }

  const status = (reqDoc as { status?: unknown }).status;
  if (status === "denied") {
    return htmlPage("Already denied", `<div style="font-weight:700;">Already denied</div><div class="muted" style="margin-top:10px;">This request has already been denied.</div>`);
  }

  // If already approved, don't regenerate token. (We may still show a confirmation.)
  if (status === "approved" && typeof (reqDoc as { claimTokenHash?: unknown }).claimTokenHash === "string") {
    return htmlPage(
      "Already approved",
      `<div style="font-weight:700;">Already approved</div><div class="muted" style="margin-top:10px;">The requester has already been emailed a claim link.</div>`,
    );
  }

  const claimToken = crypto.randomBytes(24).toString("base64url");
  const claimTokenHash = sha256Hex(claimToken);
  const now = new Date();

  // Approve atomically if still pending.
  const updateRes = await ShareDownloadRequestModel.updateOne(
    { _id: (reqDoc as { _id: unknown })._id, status: "pending" },
    { $set: { status: "approved", approvedAt: now, claimTokenHash, claimEmailError: null } },
  );

  if (updateRes.modifiedCount !== 1) {
    // Another click/race: treat as already handled.
    return htmlPage(
      "Already handled",
      `<div style="font-weight:700;">Already handled</div><div class="muted" style="margin-top:10px;">This request was updated in another session.</div>`,
    );
  }

  const requesterEmail = (reqDoc as { requesterEmail?: unknown }).requesterEmail;
  const to = typeof requesterEmail === "string" ? requesterEmail.trim().toLowerCase() : "";
  const base = getPublicSiteBase();
  const claimUrl = base ? new URL(`/download/${encodeURIComponent(claimToken)}`, base).toString() : "";

  const docId = (reqDoc as { docId?: unknown }).docId;
  const doc = await DocModel.findOne({ _id: docId, shareId, isDeleted: { $ne: true } })
    .select({ title: 1 })
    .lean();
  const title = typeof (doc as { title?: unknown } | null)?.title === "string" ? String((doc as { title: string }).title) : "Shared document";

  if (to) {
    try {
      const subject = `Download approved: ${title || "Shared document"}`;
      const text = [
        "Your download request was approved.",
        "",
        `Document: ${title || "Shared document"}`,
        "",
        claimUrl ? `Open to download or save: ${claimUrl}` : "Open to download or save: (missing NEXT_PUBLIC_SITE_URL)",
        "",
        "You’ll need to sign in to LinkDrop to continue.",
        "",
        "- LinkDrop",
      ]
        .filter(Boolean)
        .join("\n");

      await sendTextEmail({ to, subject, text });
      await ShareDownloadRequestModel.updateOne(
        { _id: (reqDoc as { _id: unknown })._id },
        { $set: { claimEmailSentAt: new Date(), claimEmailError: null } },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to send requester email";
      await ShareDownloadRequestModel.updateOne(
        { _id: (reqDoc as { _id: unknown })._id },
        { $set: { claimEmailError: msg } },
      ).catch(() => void 0);
    }
  }

  return htmlPage(
    "Approved",
    `<div style="font-weight:700;">Approved</div><div class="muted" style="margin-top:10px;">The requester will receive an email with a link to download or save this document.</div>`,
  );
}

