/**
 * API route for `/api/dashboard/usage` — returns usage rows for the Usage dashboard tab.
 *
 * Returns credit-ledger rows (credits + quality only). Never returns tokens, vendor models,
 * or raw cost on a per-row basis.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { resolveActorForStats, tryResolveAuthUserId } from "@/lib/gating/actor";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { ACTIVE_ORG_COOKIE } from "@/lib/orgs/activeOrgCookie";
import { USD_CENTS_PER_CREDIT } from "@/lib/billing/pricing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clampDays(v: string | null): 1 | 7 | 30 {
  const n = Number(v);
  if (n === 1) return 1;
  if (n === 7) return 7;
  return 30;
}

function readCookie(cookieHeader: string, name: string): string | null {
  const parts = cookieHeader.split(";").map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    const idx = p.indexOf("=");
    if (idx < 0) continue;
    const k = p.slice(0, idx).trim();
    if (k !== name) continue;
    return decodeURIComponent(p.slice(idx + 1));
  }
  return null;
}

export async function GET(request: Request) {
  return withMongoRequestLogging(request, async () => {
    try {
      const session = await tryResolveAuthUserId(request);
      if (!session?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      if (!Types.ObjectId.isValid(session.userId)) return NextResponse.json({ error: "Invalid user" }, { status: 400 });

      const cookieHeader = request.headers.get("cookie") ?? "";
      const cookieOrgIdRaw = readCookie(cookieHeader, ACTIVE_ORG_COOKIE);
      const cookieOrgId = typeof cookieOrgIdRaw === "string" ? cookieOrgIdRaw.trim() : "";
      const claimOrgId = typeof session.activeOrgId === "string" ? session.activeOrgId.trim() : "";
      const orgIdStr = cookieOrgId && Types.ObjectId.isValid(cookieOrgId) ? cookieOrgId : claimOrgId;

      // Fallback (rare): if org context is missing, resolve via the full stats actor resolver.
      const actorOrgId = orgIdStr && Types.ObjectId.isValid(orgIdStr) ? orgIdStr : null;
      let orgId: Types.ObjectId;
      if (actorOrgId) {
        orgId = new Types.ObjectId(actorOrgId);
      } else {
        const actor = await resolveActorForStats(request);
        if (actor.kind !== "user") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        if (!Types.ObjectId.isValid(actor.orgId)) return NextResponse.json({ error: "Invalid org" }, { status: 400 });
        orgId = new Types.ObjectId(actor.orgId);
      }

      const userId = new Types.ObjectId(session.userId);

      const url = new URL(request.url);
      const days = clampDays(url.searchParams.get("days"));
      const includeSpend = url.searchParams.get("includeSpend") === "1";

      await connectMongo();

      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      // Validate membership once; also yields role for "Spend" permission.
      const membership = await OrgMembershipModel.findOne({ orgId, userId, isDeleted: { $ne: true } }).select({ role: 1 }).lean();
      if (!membership) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      const role = typeof (membership as any)?.role === "string" ? String((membership as any).role) : "";
      const canViewSpend = includeSpend && (role === "owner" || role === "admin");

      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));

      // Fetch rows for the selected window; month-to-date spend is a separate query (when allowed)
      // so we don't force the main query to scan extra days.
      const windowStart = since;

      const rowsAggPromise = CreditLedgerModel.aggregate([
        {
          $match: {
            workspaceId: orgId,
            eventType: "ai_run",
            createdDate: { $gte: windowStart },
          },
        },
        { $sort: { createdDate: -1 } },
        { $limit: 200 },
        {
          $lookup: {
            from: "docs",
            localField: "docId",
            foreignField: "_id",
            as: "doc",
          },
        },
        { $unwind: { path: "$doc", preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: "users",
            localField: "userId",
            foreignField: "_id",
            as: "user",
          },
        },
        { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 1,
            createdDate: 1,
            actionType: 1,
            qualityTier: 1,
            status: 1,
            creditsCharged: 1,
            doc: { _id: 1, title: 1 },
            user: { _id: 1, name: 1, email: 1 },
          },
        },
      ]);

      const monthSpendAggPromise = canViewSpend
        ? CreditLedgerModel.aggregate([
            {
              $match: {
                workspaceId: orgId,
                eventType: "ai_run",
                status: "charged",
                createdDate: { $gte: monthStart },
              },
            },
            { $group: { _id: null, sum: { $sum: "$creditsCharged" } } },
          ])
        : Promise.resolve([]);

      const [rowsAgg, monthAgg] = await Promise.all([rowsAggPromise, monthSpendAggPromise]);

      // Optional: month-to-date spend (credits × USD_CENTS_PER_CREDIT), owner/admin only.
      let monthSpendCents: number | null = null;
      if (canViewSpend) {
        const credits =
          typeof (monthAgg as any)?.[0]?.sum === "number" && Number.isFinite((monthAgg as any)[0].sum)
            ? Math.max(0, Math.floor((monthAgg as any)[0].sum))
            : 0;
        monthSpendCents = credits * USD_CENTS_PER_CREDIT;
      }

      return NextResponse.json(
        {
          ok: true,
          days,
          canViewSpend: Boolean(canViewSpend),
          monthSpendCents,
          rows: (Array.isArray(rowsAgg) ? rowsAgg : []).map((r: any) => ({
            id: String(r._id),
            createdAt: r.createdDate ? new Date(r.createdDate).toISOString() : new Date().toISOString(),
            action: typeof r.actionType === "string" ? r.actionType : "unknown",
            quality: typeof r.qualityTier === "string" ? r.qualityTier : "standard",
            status: typeof r.status === "string" ? r.status : "pending",
            credits:
              typeof r.creditsCharged === "number" && Number.isFinite(r.creditsCharged)
                ? Math.max(0, Math.floor(r.creditsCharged))
                : 0,
            doc: r.doc && r.doc._id ? { id: String(r.doc._id), title: typeof r.doc.title === "string" ? r.doc.title : null } : null,
            user: r.user && r.user._id ? { id: String(r.user._id), name: typeof r.user.name === "string" ? r.user.name : null, email: typeof r.user.email === "string" ? r.user.email : null } : null,
          })),
        },
        { headers: { "cache-control": "no-store" } },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load usage";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
  });
}


