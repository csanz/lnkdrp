/**
 * API route: POST `/api/share/:shareId/download-requests`
 *
 * Public endpoint used by the share viewer when PDF downloads are disabled.
 * Creates a download request and emails the doc owner with approve/deny links.
 */
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { Types } from "mongoose";
import { resolveShareLink, shareLinkUnlocked, type PasswordProtectedLink } from "@/lib/share/links";
import { resolveProjectLink } from "@/lib/share/projectLinks";
import { resolveProjectStatsTarget } from "@/lib/share/projectPublic";
import { UserModel } from "@/lib/models/User";
import { ShareDownloadRequestModel } from "@/lib/models/ShareDownloadRequest";
import { sendEmailContent } from "@/lib/email/sendTextEmail";
import { downloadRequestOwnerEmail, downloadRequestReceivedEmail } from "@/lib/email/templates";
import { workspaceForEmail } from "@/lib/email/workspaceIdentity";
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

    const body = (await request.json().catch(() => ({}))) as { email?: unknown; docId?: unknown };
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
    //
    /**
     * A request can come from a document link or from inside a data room, and the two name their
     * document differently: a document link *is* the document, while a project link fronts many, so
     * the room's slug plus the document being read is what identifies one.
     *
     * `resolveProjectStatsTarget` takes the document from the body, or from the `/p/:slug/:docId`
     * page that made the request, and re-proves it is a live member of that room — the same
     * membership check the room's own pages make.
     *
     * This used to refuse a project slug outright, because the rest of the chain did too: the owner
     * would be emailed, they would approve, and the requester's claim link would 404. That is fixed
     * in `resolveClaimLink`, which the three claim routes now share, so both ends understand a room.
     */
    const directLink = await resolveShareLink(shareId, { select: { title: 1 } as Record<string, 1> });
    /**
     * A locked room answers the same thing about every document id, member or not.
     *
     * `resolveProjectStatsTarget` resolves the link and the document together, so on a room the
     * caller had no password for this route answered 404 for an id outside the room and 401 for
     * one inside it: an inventory of the room, handed out by the one thing the password is there
     * to withhold (docs/SECURITY.md, 7.8; the page, the PDF proxy and the ingest were closed
     * first, this was the fourth door). So the link is resolved on its own first, the password
     * gate runs on it, and only then is the document looked up. The membership lookup does not run
     * for a locked room at all.
     */
    if (!directLink) {
      const roomLink = await resolveProjectLink(shareId);
      if (!roomLink || roomLink.refusal) return NextResponse.json({ error: "Not found" }, { status: 404 });
      if (!shareLinkUnlocked(request, shareId, roomLink.link as PasswordProtectedLink)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }
    const roomTarget = directLink
      ? null
      : await resolveProjectStatsTarget({
          shareId,
          request,
          bodyDocId: body.docId,
          // `userId` is not in `PROJECT_DOC_LIST_FIELDS` — a room's public listing has no reason to
          // carry the owner — but `ownerUserId` below is read off this document and decides who is
          // emailed for approval. Without it the request is created and nobody is ever asked,
          // which is the same half-a-chain failure this route used to refuse project slugs to
          // avoid. The document path gets it for free from `DOC_SHARE_FIELDS`.
          select: { title: 1, userId: 1 } as Record<string, 1>,
        });
    const resolved = directLink ?? roomTarget;
    if (!resolved || resolved.refusal) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // A protected link says nothing to a browser that never typed the password — and "I would like
    // this PDF" is a way to be handed the PDF. Without this the holder of a forwarded slug could
    // start the chain, and the owner's approval mail gave them no way to tell: it names a document
    // they did share and an address the requester chose. The check sits above the
    // `download_already_enabled` answer below because that answer is itself a fact about the link.
    if (!shareLinkUnlocked(request, shareId, resolved.link)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const doc = resolved.doc;
    const docTitle = typeof doc.title === "string" ? doc.title : null;

    // If downloads are already enabled, no need to request. This is a fact about the link, not
    // about any person, so it keeps its own answer — see the note on the response shape below.
    if (Boolean(resolved.link.allowDownload)) {
      return NextResponse.json({ ok: true, kind: "download_already_enabled" as const });
    }

    /**
     * De-dupe — without letting one stranger act for another.
     *
     * The only identity in this request is the address the caller typed into a public form, so
     * every branch here has to stay safe when that address belongs to somebody else. Two things
     * went wrong on the way to "only one request remains actionable":
     *
     * - A pending row older than the window was flipped to `denied` before a fresh one was made.
     *   That is a *write on a third party's row*: anyone holding the slug could post the
     *   recipient's address, and the approve link already sitting in the owner's inbox would stop
     *   working — it matches the old row, sees `denied`, and short-circuits at
     *   `[token]/approve/route.ts` with "Already denied". The owner clicked Approve, nothing
     *   happened, and nothing said why. The old row is now left alone: two live requests for the
     *   same address on the same link are harmless, because approving either one hands the same
     *   person the same document, and every approve link the owner was ever sent keeps working.
     * - The answer named which branch ran (`created` / `resent` / `already_requested`), which made
     *   this public endpoint a lookup for "does this address have a request outstanding on this
     *   link?" — i.e. who has been asking the owner for the file. Every accepted submission now
     *   answers with the same body.
     *
     * The window itself is unchanged and is now expressed in the query rather than recomputed from
     * `createdDate`: a row newer than `DEDUPE_WINDOW_MS` suppresses this submission entirely.
     */
    const recentPending = await ShareDownloadRequestModel.findOne({
      shareId,
      requesterEmail: email,
      status: "pending",
      createdDate: { $gt: new Date(Date.now() - DEDUPE_WINDOW_MS) },
    })
      .sort({ createdDate: -1 })
      .select({ _id: 1 })
      .lean();
    if (recentPending) {
      // Inside the window the request that already exists *is* the answer: no second row, no
      // second pair of emails, and the same body a fresh create returns, so a caller cannot tell
      // this branch from that one.
      return NextResponse.json({ ok: true, kind: "created" as const });
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
      await sendEmailContent({
        to: email,
        ...downloadRequestReceivedEmail({ title, shareUrl, workspace: await workspaceForEmail(activityOrgId) }),
      });
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
        await sendEmailContent({
          to: ownerEmail,
          ...downloadRequestOwnerEmail({
            title,
            shareUrl,
            requesterEmail: email,
            approveUrl,
            denyUrl,
            workspace: await workspaceForEmail(activityOrgId),
          }),
        });
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

    // One body for every accepted submission. `emailedOwner` / `emailedRequester` used to ride
    // along here; they are the delivery status of somebody else's mail, nothing in the viewer read
    // them, and together with `kind` they were the other half of the outstanding-request oracle.
    // They are still recorded on the row (`ownerEmailSentAt`, `requesterEmailError`, …) where the
    // owner and the admin email screen can see them.
    debugLog(2, "[api/share/*/download-requests] created", { shareId, emailedOwner, emailedRequester });
    return NextResponse.json({ ok: true, kind: "created" as const });
  } catch (err) {
    return errorJson(err, {
      status: 500,
      publicMessage: "Could not submit download request",
      context: "[api/share/*/download-requests] POST failed",
    });
  }
}

