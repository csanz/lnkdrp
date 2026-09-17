/**
 * Admin API route: `GET /api/admin/credits/ledger`
 *
 * Read-only tail of `CreditLedger`: the most recent rows with their action, quality tier, credits
 * (estimated / reserved / charged), status, event type and which bucket paid. Optionally scoped to
 * one workspace with `?workspaceId=`.
 *
 * Telemetry and true-cost fields are contractually internal ("never returned in customer APIs");
 * this is an admin surface, so the cost columns are included and the token/provider telemetry is
 * left out because nothing on the page uses it yet.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { OrgModel } from "@/lib/models/Org";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { requireAdmin } from "@/lib/gating/requireAdmin";
import { asNumber, isStalePending } from "@/lib/admin/creditsAdmin";

export const runtime = "nodejs";

/** Positive integer from a query param, or null. */
function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
}

/** Only these event types may be asked for; anything else is a client typo, not an empty table. */
const EVENT_TYPES = new Set(["ai_run", "cycle_grant_included", "credit_pack_purchase", "credit_pack_expired", "free_floor_grant"]);

type LedgerLean = {
  _id: Types.ObjectId;
  workspaceId?: Types.ObjectId;
  userId?: Types.ObjectId | null;
  docId?: Types.ObjectId | null;
  actionType?: string;
  qualityTier?: string;
  status?: string;
  eventType?: string;
  source?: string;
  creditsEstimated?: number;
  creditsReserved?: number;
  creditsCharged?: number;
  creditsFromTrial?: number;
  creditsFromSubscription?: number;
  creditsFromPurchased?: number;
  creditsFromOnDemand?: number;
  cycleKey?: string | null;
  adminReason?: string | null;
  adminActorEmail?: string | null;
  createdDate?: Date;
};

/**
 *
 */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const url = new URL(request.url);
  const limit = Math.min(asPositiveInt(url.searchParams.get("limit")) ?? 50, 200);
  const workspaceIdRaw = (url.searchParams.get("workspaceId") ?? "").trim();
  const eventTypeRaw = (url.searchParams.get("eventType") ?? "").trim();
  const statusRaw = (url.searchParams.get("status") ?? "").trim();

  if (workspaceIdRaw && !Types.ObjectId.isValid(workspaceIdRaw)) {
    return NextResponse.json({ error: "workspaceId must be a Mongo ObjectId" }, { status: 400 });
  }
  if (eventTypeRaw && !EVENT_TYPES.has(eventTypeRaw)) {
    return NextResponse.json({ error: `eventType must be one of: ${[...EVENT_TYPES].join(" | ")}` }, { status: 400 });
  }
  if (statusRaw && !["pending", "charged", "refunded", "failed"].includes(statusRaw)) {
    return NextResponse.json({ error: "status must be one of: pending | charged | refunded | failed" }, { status: 400 });
  }

  await connectMongo();

  const filter: Record<string, unknown> = {};
  if (workspaceIdRaw) filter.workspaceId = new Types.ObjectId(workspaceIdRaw);
  if (eventTypeRaw) filter.eventType = eventTypeRaw;
  if (statusRaw) filter.status = statusRaw;

  // Scoped to a workspace, `{ workspaceId: 1, createdDate: -1 }` serves newest-first directly.
  // Fleet-wide there is no index starting at `createdDate`, so sorting by it would be a blocking
  // sort over the whole ledger; `_id` is monotonic with insertion time and always indexed, so it
  // gives the same "newest first" without one.
  const sort: Record<string, -1> = workspaceIdRaw ? { createdDate: -1 } : { _id: -1 };

  const rows = (await CreditLedgerModel.find(filter)
    .sort(sort)
    .limit(limit)
    .select({
      workspaceId: 1,
      userId: 1,
      docId: 1,
      actionType: 1,
      qualityTier: 1,
      status: 1,
      eventType: 1,
      source: 1,
      creditsEstimated: 1,
      creditsReserved: 1,
      creditsCharged: 1,
      creditsFromTrial: 1,
      creditsFromSubscription: 1,
      creditsFromPurchased: 1,
      creditsFromOnDemand: 1,
      cycleKey: 1,
      adminReason: 1,
      adminActorEmail: 1,
      createdDate: 1,
    })
    .lean()) as LedgerLean[];

  const orgIds = rows.map((r) => r.workspaceId).filter((v): v is Types.ObjectId => v instanceof Types.ObjectId);
  const orgs = await OrgModel.find({ _id: { $in: orgIds } }).select({ name: 1 }).lean();
  const nameByOrgId = new Map(orgs.map((o) => [String(o._id), typeof o.name === "string" ? o.name : null]));

  const nowMs = Date.now();

  return NextResponse.json({
    ok: true,
    limit,
    workspaceId: workspaceIdRaw || null,
    eventType: eventTypeRaw || null,
    status: statusRaw || null,
    items: rows.map((r) => {
      const workspaceId = String(r.workspaceId ?? "");
      const createdDate = r.createdDate instanceof Date ? r.createdDate : null;
      const status = typeof r.status === "string" ? r.status : "unknown";
      return {
        id: String(r._id),
        workspaceId,
        workspaceName: nameByOrgId.get(workspaceId) ?? null,
        docId: r.docId instanceof Types.ObjectId ? String(r.docId) : null,
        userId: r.userId instanceof Types.ObjectId ? String(r.userId) : null,
        actionType: typeof r.actionType === "string" ? r.actionType : null,
        qualityTier: typeof r.qualityTier === "string" ? r.qualityTier : null,
        status,
        eventType: typeof r.eventType === "string" ? r.eventType : null,
        source: typeof r.source === "string" ? r.source : null,
        creditsEstimated: asNumber(r.creditsEstimated),
        creditsReserved: asNumber(r.creditsReserved),
        creditsCharged: asNumber(r.creditsCharged),
        split: {
          starter: asNumber(r.creditsFromTrial),
          subscription: asNumber(r.creditsFromSubscription),
          purchased: asNumber(r.creditsFromPurchased),
          onDemand: asNumber(r.creditsFromOnDemand),
        },
        cycleKey: typeof r.cycleKey === "string" ? r.cycleKey : null,
        adminReason: typeof r.adminReason === "string" ? r.adminReason : null,
        adminActorEmail: typeof r.adminActorEmail === "string" ? r.adminActorEmail : null,
        createdDate: createdDate ? createdDate.toISOString() : null,
        stalePending: createdDate
          ? isStalePending({ status, createdAtMs: createdDate.getTime(), nowMs })
          : false,
      };
    }),
  });
}
