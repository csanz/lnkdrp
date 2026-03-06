/**
 * API route: POST `/api/share/:shareId/download-requests`
 *
 * Public endpoint used by the share viewer when PDF downloads are disabled.
 * Creates a download request and emails the doc owner with approve/deny links.
 */
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { UserModel } from "@/lib/models/User";
import { ShareDownloadRequestModel } from "@/lib/models/ShareDownloadRequest";
import { sendTextEmail } from "@/lib/email/sendTextEmail";
import { getPublicSiteBase } from "@/lib/urls";
import { debugError, debugLog, debugWarn } from "@/lib/debug";

export const runtime = "nodejs";

const DEDUPE_WINDOW_MS = 60 * 1000;

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function looksLikeEmail(email: string): boolean {
  // Minimal check: keep this permissive to avoid rejecting legitimate addresses.
  const s = email.trim();
  return s.includes("@") && s.includes(".") && s.length <= 320;
}

export async function POST(request: Request, ctx: { params: Promise<{ shareId: string }> }) {
  try {
    const { shareId } = await ctx.params;
    if (!shareId) return NextResponse.json({ error: "Missing shareId" }, { status: 400 });

    const body = (await request.json().catch(() => ({}))) as { email?: unknown };
    const rawEmail = typeof body.email === "string" ? body.email : "";
    const email = normalizeEmail(rawEmail);
    if (!email || !looksLikeEmail(email)) {
      return NextResponse.json({ error: "Please enter a valid email." }, { status: 400 });
    }

    debugLog(2, "[api/share/*/download-requests] POST", { shareId, email: "[redacted]" });

    await connectMongo();
    const doc = await DocModel.findOne({ shareId, isDeleted: { $ne: true } })
      .select({ _id: 1, userId: 1, title: 1, shareEnabled: 1, shareAllowPdfDownload: 1 })
      .lean();
    if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if ((doc as { shareEnabled?: unknown }).shareEnabled === false) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // If downloads are already enabled, no need to request.
    if (Boolean((doc as { shareAllowPdfDownload?: unknown }).shareAllowPdfDownload)) {
      return NextResponse.json({ ok: true, kind: "download_already_enabled" as const, emailedOwner: false });
    }

    // De-dupe: suppress repeat requests for a short window (avoid spam),
    // but allow retry after that so the requester can resend.
    const existingPending = await ShareDownloadRequestModel.findOne({
      shareId,
      requesterEmail: email,
      status: "pending",
    })
      .sort({ createdDate: -1 })
      .select({ _id: 1, createdDate: 1 })
      .lean();
    if (existingPending) {
      const createdDate = (existingPending as { createdDate?: unknown }).createdDate;
      const createdAtMs = createdDate instanceof Date ? createdDate.getTime() : 0;
      const ageMs = createdAtMs ? Date.now() - createdAtMs : Number.POSITIVE_INFINITY;

      if (Number.isFinite(ageMs) && ageMs < DEDUPE_WINDOW_MS) {
        const retryAfterSeconds = Math.max(1, Math.ceil((DEDUPE_WINDOW_MS - ageMs) / 1000));
        return NextResponse.json({
          ok: true,
          kind: "already_requested" as const,
          emailedOwner: false,
          retryAfterSeconds,
        });
      }

      // Allow resend: mark the old pending request as denied so only one request remains actionable.
      await ShareDownloadRequestModel.updateOne(
        { _id: (existingPending as { _id: unknown })._id, status: "pending" },
        { $set: { status: "denied", deniedAt: new Date() } },
      ).catch(() => void 0);
    }

    const requestToken = crypto.randomBytes(24).toString("base64url");
    const requestTokenHash = sha256Hex(requestToken);
    const docId = (doc as { _id: unknown })._id;
    const ownerUserId = (doc as { userId?: unknown }).userId;

    const created = await ShareDownloadRequestModel.create({
      shareId,
      docId,
      ownerUserId,
      requesterEmail: email,
      status: "pending",
      requestTokenHash,
      // IMPORTANT:
      // Some environments may already have a unique index on claimTokenHash that treats missing/null
      // values as duplicates (E11000 { claimTokenHash: null }). To keep inserts working without requiring
      // an immediate index rebuild, we set a unique placeholder value up-front and overwrite it on approval.
      claimTokenHash: requestTokenHash,
    });

    // Best-effort: email the requester (receipt/ack).
    // (Do this only when we create a new request record to avoid spamming on within-window dupes.)
    let emailedRequester = false;
    try {
      const base = getPublicSiteBase();
      const title =
        typeof (doc as { title?: unknown }).title === "string" ? (doc as { title: string }).title : "Shared document";
      const shareUrl = base ? new URL(`/s/${encodeURIComponent(shareId)}`, base).toString() : "";
      const subject = `Request received: ${title || "Shared document"}`;
      const text = [
        "We sent your request to the owner to allow downloading this PDF.",
        "",
        `Document: ${title || "Shared document"}`,
        shareUrl ? `Link: ${shareUrl}` : null,
        "",
        "If approved, you’ll receive another email with a link to download or save it to your LinkDrop account (sign-in required).",
        "",
        "- LinkDrop",
      ]
        .filter(Boolean)
        .join("\n");
      await sendTextEmail({ to: email, subject, text });
      emailedRequester = true;
      await ShareDownloadRequestModel.updateOne(
        { _id: created._id },
        { $set: { requesterEmailSentAt: new Date(), requesterEmailError: null } },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to send requester email";
      debugWarn(1, "[api/share/*/download-requests] requester email failed", { shareId, message: msg });
      await ShareDownloadRequestModel.updateOne(
        { _id: created._id },
        { $set: { requesterEmailError: msg } },
      ).catch(() => void 0);
    }

    // Best-effort: email the owner.
    const owner = ownerUserId
      ? await UserModel.findOne({ _id: ownerUserId }).select({ email: 1, name: 1 }).lean()
      : null;
    const ownerEmail = owner && typeof (owner as { email?: unknown }).email === "string" ? String((owner as { email: string }).email) : "";

    const base = getPublicSiteBase();
    const title = typeof (doc as { title?: unknown }).title === "string" ? (doc as { title: string }).title : "Shared document";
    const shareUrl = base ? new URL(`/s/${encodeURIComponent(shareId)}`, base).toString() : "";
    const approveUrl = base
      ? new URL(
          `/api/share/${encodeURIComponent(shareId)}/download-requests/${encodeURIComponent(requestToken)}/approve`,
          base,
        ).toString()
      : "";
    const denyUrl = base
      ? new URL(
          `/api/share/${encodeURIComponent(shareId)}/download-requests/${encodeURIComponent(requestToken)}/deny`,
          base,
        ).toString()
      : "";

    let emailedOwner = false;
    if (ownerEmail) {
      try {
        const subject = `Download request: ${title || "Shared document"}`;
        const text = [
          "A receiver requested a PDF download.",
          "",
          `Document: ${title || "Shared document"}`,
          shareUrl ? `Share link: ${shareUrl}` : null,
          "",
          `Requester email: ${email}`,
          "",
          approveUrl ? `Approve: ${approveUrl}` : "Approve: (missing NEXT_PUBLIC_SITE_URL)",
          denyUrl ? `Deny: ${denyUrl}` : "Deny: (missing NEXT_PUBLIC_SITE_URL)",
          "",
          "- LinkDrop",
        ]
          .filter(Boolean)
          .join("\n");

        await sendTextEmail({ to: ownerEmail, subject, text });
        emailedOwner = true;
        await ShareDownloadRequestModel.updateOne(
          { _id: created._id },
          { $set: { ownerEmailSentAt: new Date(), ownerEmailError: null } },
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to send owner email";
        debugWarn(1, "[api/share/*/download-requests] owner email failed", { shareId, message: msg });
        await ShareDownloadRequestModel.updateOne(
          { _id: created._id },
          { $set: { ownerEmailError: msg } },
        ).catch(() => void 0);
      }
    } else {
      debugWarn(1, "[api/share/*/download-requests] missing owner email", { shareId });
    }

    return NextResponse.json({
      ok: true,
      kind: existingPending ? "resent" as const : "created" as const,
      emailedOwner,
      emailedRequester,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/share/*/download-requests] POST failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

