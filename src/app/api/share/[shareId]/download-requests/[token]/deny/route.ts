/**
 * API route: GET `/api/share/:shareId/download-requests/:token/deny`
 *
 * Token-based denial link intended to be clicked from the owner's email.
 * Currently records the denial; it does not email the requester.
 */
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { connectMongo } from "@/lib/mongodb";
import { ShareDownloadRequestModel } from "@/lib/models/ShareDownloadRequest";

export const runtime = "nodejs";

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
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

export async function GET(_request: Request, ctx: { params: Promise<{ shareId: string; token: string }> }) {
  const { shareId, token } = await ctx.params;
  if (!shareId || !token) return NextResponse.json({ error: "Missing params" }, { status: 400 });

  await connectMongo();
  const requestTokenHash = sha256Hex(token);
  const reqDoc = await ShareDownloadRequestModel.findOne({ shareId, requestTokenHash })
    .select({ _id: 1, status: 1 })
    .lean();
  if (!reqDoc) {
    return htmlPage("Not found", `<div style="font-weight:700;">Request not found</div><div class="muted" style="margin-top:10px;">This denial link is invalid or expired.</div>`);
  }

  const status = (reqDoc as { status?: unknown }).status;
  if (status === "approved") {
    return htmlPage("Already approved", `<div style="font-weight:700;">Already approved</div><div class="muted" style="margin-top:10px;">This request was already approved.</div>`);
  }
  if (status === "denied") {
    return htmlPage("Already denied", `<div style="font-weight:700;">Already denied</div><div class="muted" style="margin-top:10px;">This request has already been denied.</div>`);
  }

  await ShareDownloadRequestModel.updateOne(
    { _id: (reqDoc as { _id: unknown })._id, status: "pending" },
    { $set: { status: "denied", deniedAt: new Date() } },
  );

  return htmlPage("Denied", `<div style="font-weight:700;">Denied</div><div class="muted" style="margin-top:10px;">This download request has been denied.</div>`);
}

