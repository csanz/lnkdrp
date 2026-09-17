/**
 * API route: POST `/api/share/:shareId/download-requests`
 *
 * Public endpoint used by the share viewer when PDF downloads are disabled.
 * Creates a download request and emails the doc owner with approve/deny links.
 */
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { Types } from "mongoose";
import { resolveShareLink } from "@/lib/share/links";
import { UserModel } from "@/lib/models/User";
import { ShareDownloadRequestModel } from "@/lib/models/ShareDownloadRequest";
import { sendTextEmail } from "@/lib/email/sendTextEmail";
import { downloadRequestOwnerEmail, downloadRequestReceivedEmail } from "@/lib/email/templates";
import { getPublicSiteBase } from "@/lib/urls";
import { debugLog, debugWarn } from "@/lib/debug";
import { clientIpFromRequest, rateLimit, rateLimitedResponse } from "@/lib/http/rateLimit";
import { errorJson } from "@/lib/http/errorResponse";
import { ensurePersonalOrgForUserId } from "@/lib/models/Org";
import { recordActivity } from "@/lib/activity/log";

export const runtime = "nodejs";

const DEDUPE_WINDOW_MS = 60 * 1000;
/** Download requests per hour, enforced independently per IP and per requester email (each sends 2 emails). */
const REQUEST_LIMIT = 5;
const REQUEST_WINDOW_MS = 60 * 60 * 1000;

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

/** Mask an email for the activity feed: first char + domain (`c***@example.com`). */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email.charAt(0)}***@${email.slice(at + 1)}`;
}

/**
 * Best-effort org for a doc's activity row: `doc.orgId`, else the owner's personal org (legacy docs).
 *
 * Returns null (activity skipped) when neither can be resolved; never throws.
 */
async function resolveDocOrgIdForActivity(doc: { orgId?: unknown; userId?: unknown }): Promise<string | null> {
  if (doc.orgId) return String(doc.orgId);
  if (!doc.userId) return null;
  try {
    const { orgId } = await ensurePersonalOrgForUserId({ userId: new Types.ObjectId(String(doc.userId)) });
    return String(orgId);
  } catch {
    return null;
  }
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

    const ip = clientIpFromRequest(request);
    const rlIp = await rateLimit({ key: `dlreq:ip:${ip}`, limit: REQUEST_LIMIT, windowMs: REQUEST_WINDOW_MS });
    if (!rlIp.ok) return rateLimitedResponse(rlIp);
    const rlEmail = await rateLimit({ key: `dlreq:email:${sha256Hex(email)}`, limit: REQUEST_LIMIT, windowMs: REQUEST_WINDOW_MS });
    if (!rlEmail.ok) return rateLimitedResponse(rlEmail);

    // The request is about one link: a refused link answers 404, and the download permission that
    // decides whether a request is needed is the link's (docs/prds/lnkdrp-multi-links.md).
    const resolved = await resolveShareLink(shareId, { select: { title: 1 } as Record<string, 1> });
    if (!resolved || resolved.refusal) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const doc = resolved.doc;
    const docTitle = typeof doc.title === "string" ? doc.title : null;

    // If downloads are already enabled, no need to request.
    if (Boolean(resolved.link.allowDownload)) {
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

    // Activity (best-effort): the requester is anonymous, so attribute the row to the doc's org only.
    const activityOrgId = await resolveDocOrgIdForActivity(doc as { orgId?: unknown; userId?: unknown });
    if (activityOrgId) {
      void recordActivity({
        orgId: activityOrgId,
        userId: null,
        actorKind: "secret",
        type: "download_request.created",
        docId: docId as Types.ObjectId,
        title: docTitle,
        meta: {
          email: maskEmail(email),
          shareId,
          requestId: String(created._id),
          // Which link the request came through, so the feed can say "via Benchmark".
          linkLabel: resolved.link.label ?? null,
          isDefaultLink: Boolean(resolved.link.isDefault),
        },
        request,
      });
    }

    // Best-effort: email the requester (receipt/ack).
    // (Do this only when we create a new request record to avoid spamming on within-window dupes.)
    let emailedRequester = false;
    try {
      const base = getPublicSiteBase();
      const title = docTitle ?? "Shared document";
      const shareUrl = base ? new URL(`/s/${encodeURIComponent(shareId)}`, base).toString() : "";
      const { subject, text } = downloadRequestReceivedEmail({ title, shareUrl });
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
    const title = docTitle ?? "Shared document";
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
        const { subject, text } = downloadRequestOwnerEmail({ title, shareUrl, requesterEmail: email, approveUrl, denyUrl });
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
    return errorJson(err, {
      status: 400,
      publicMessage: "Could not submit download request",
      context: "[api/share/*/download-requests] POST failed",
    });
  }
}

