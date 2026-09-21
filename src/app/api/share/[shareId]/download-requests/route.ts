/**
 * API route: POST `/api/share/:shareId/download-requests`
 *
 * Public endpoint used by the share viewer when PDF downloads are disabled.
 * Creates a download request and emails the doc owner with approve/deny links.
 */
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { Types } from "mongoose";
import { resolveShareLink, shareLinkUnlocked } from "@/lib/share/links";
import { UserModel } from "@/lib/models/User";
import { ShareDownloadRequestModel } from "@/lib/models/ShareDownloadRequest";
import { sendEmailContent } from "@/lib/email/sendTextEmail";
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
    //
    // KNOWN GAP — a project link's slug lands in the 404 below, so "Request download" never works
    // inside a data room. `resolveShareLink` returns null for a project slug by design, and this
    // route could resolve one: `resolveProjectStatsTarget({ shareId, request, bodyDocId })` in
    // `src/lib/share/projectPublic.ts` names the document from the body or the `/p/:slug/:docId`
    // referer and re-proves its membership, `shareLinkUnlocked` already works on a project row
    // (same cookie, same HMAC — `/p/**` uses it), and `link.allowDownload` carries the same meaning
    // there (project-links PRD decision 3). Approval would stay per-document, because a claim token
    // is minted against this row's `docId` and never touches `allowDownload`.
    //
    // It is not done here because the *rest of the chain* refuses the same slug, and half a chain
    // is worse than an honest failure: the owner would be emailed, they would approve, and the
    // requester's claim link would 404. All three claim routes gate on
    // `resolveShareLink(reqDoc.shareId)` and bail on null — `api/download/[token]/route.ts:61`,
    // `api/download/[token]/pdf/route.ts:81`, `api/download/[token]/save/route.ts:82` — which is
    // the right gate (an approval is permission *through that link*) applied by a resolver that
    // cannot see project links. Storing the document's own default-link slug on the row instead is
    // not a fix: it would answer with a different link's enable/expiry/password state than the one
    // the recipient actually used. The fix is one shared resolver those three routes call, falling
    // back to `resolveProjectLink` + `findProjectDocument` for a project slug; then delete this
    // note and take the branch above.
    const resolved = await resolveShareLink(shareId, { select: { title: 1 } as Record<string, 1> });
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
      await sendEmailContent({ to: email, ...downloadRequestReceivedEmail({ title, shareUrl }) });
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
          ...downloadRequestOwnerEmail({ title, shareUrl, requesterEmail: email, approveUrl, denyUrl }),
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
      status: 400,
      publicMessage: "Could not submit download request",
      context: "[api/share/*/download-requests] POST failed",
    });
  }
}

