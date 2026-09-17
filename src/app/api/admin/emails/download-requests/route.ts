/**
 * Admin API route: `GET /api/admin/emails/download-requests`
 *
 * The one place individual email sends are recorded: `ShareDownloadRequest` stamps a sent-at (or an
 * error) for each of the three download-request emails. Newest first, paged.
 *
 * There is no equivalent for any other email in the product — see `/a/emails` for what is and is
 * not recorded.
 */
import { NextResponse } from "next/server";

import { connectMongo } from "@/lib/mongodb";
import { ShareDownloadRequestModel } from "@/lib/models/ShareDownloadRequest";
import { requireAdmin } from "@/lib/gating/requireAdmin";
import { sendOutcome, type SendOutcome } from "@/lib/admin/emailsAdmin";

export const runtime = "nodejs";

const STATUSES = new Set(["pending", "approved", "denied"]);

/** A whole number >= 1, or null. */
function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
}

/** A non-empty trimmed string, or null. */
function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Mongo hands back `Date`; the wire carries ISO strings. */
function asIso(v: unknown): string | null {
  return v instanceof Date ? v.toISOString() : null;
}

type DownloadRequestRow = {
  requestId: string;
  shareId: string | null;
  docId: string | null;
  requesterEmail: string | null;
  status: string | null;
  createdDate: string | null;
  approvedAt: string | null;
  deniedAt: string | null;
  /** Receipt to the requester, owner approve/deny mail, claim link after approval. */
  requesterEmailOutcome: SendOutcome;
  ownerEmailOutcome: SendOutcome;
  claimEmailOutcome: SendOutcome;
};

/** Handle GET requests. */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const url = new URL(request.url);
  const limit = Math.min(asPositiveInt(url.searchParams.get("limit")) ?? 50, 200);
  const page = Math.max(asPositiveInt(url.searchParams.get("page")) ?? 1, 1);
  const statusRaw = (url.searchParams.get("status") ?? "").trim();
  const filter: Record<string, unknown> = {};
  if (STATUSES.has(statusRaw)) filter.status = statusRaw;

  await connectMongo();
  const total = await ShareDownloadRequestModel.countDocuments(filter);
  const docs = await ShareDownloadRequestModel.find(filter)
    // `_id` tiebreak so paging is stable when several requests land in the same millisecond.
    .sort({ createdDate: -1, _id: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .select({
      shareId: 1,
      docId: 1,
      requesterEmail: 1,
      status: 1,
      createdDate: 1,
      approvedAt: 1,
      deniedAt: 1,
      ownerEmailSentAt: 1,
      ownerEmailError: 1,
      requesterEmailSentAt: 1,
      requesterEmailError: 1,
      claimEmailSentAt: 1,
      claimEmailError: 1,
    })
    .lean();

  const items: DownloadRequestRow[] = docs.map((raw) => {
    const d = raw as Record<string, unknown>;
    return {
      requestId: String(d._id),
      shareId: asString(d.shareId),
      docId: d.docId ? String(d.docId) : null,
      requesterEmail: asString(d.requesterEmail),
      status: asString(d.status),
      createdDate: asIso(d.createdDate),
      approvedAt: asIso(d.approvedAt),
      deniedAt: asIso(d.deniedAt),
      requesterEmailOutcome: sendOutcome(asIso(d.requesterEmailSentAt), asString(d.requesterEmailError)),
      ownerEmailOutcome: sendOutcome(asIso(d.ownerEmailSentAt), asString(d.ownerEmailError)),
      claimEmailOutcome: sendOutcome(asIso(d.claimEmailSentAt), asString(d.claimEmailError)),
    };
  });

  return NextResponse.json({ ok: true, total, page, limit, items });
}
