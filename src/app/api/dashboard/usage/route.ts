/**
 * API route for `/api/dashboard/usage` — returns usage rows for the Usage dashboard tab.
 *
 * Returns credit-ledger rows (credits + quality only). Never returns tokens, vendor models,
 * or raw cost on a per-row basis.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { resolveActorForStats } from "@/lib/gating/actor";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clampDays(v: string | null): 1 | 7 | 30 {
  const n = Number(v);
  if (n === 1) return 1;
  if (n === 7) return 7;
  return 30;
}

export async function GET(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActorForStats(request);
    try {
      if (actor.kind !== "user") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      if (!Types.ObjectId.isValid(actor.userId)) return NextResponse.json({ error: "Invalid user" }, { status: 400 });
      if (!Types.ObjectId.isValid(actor.orgId)) return NextResponse.json({ error: "Invalid org" }, { status: 400 });

      const url = new URL(request.url);
      const days = clampDays(url.searchParams.get("days"));
      const includeSpend = url.searchParams.get("includeSpend") === "1";

      await connectMongo();
      const orgId = new Types.ObjectId(actor.orgId);

      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      // Best-effort permission for optional spend aggregate (owner/admin only).
      let canViewSpend = false;
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
      if (includeSpend) {
        const membership = await OrgMembershipModel.findOne({
          orgId,
          userId: new Types.ObjectId(actor.userId),
          isDeleted: { $ne: true },
        })
          .select({ role: 1 })
          .lean();
        const role = typeof (membership as any)?.role === "string" ? String((membership as any).role) : "";
        canViewSpend = role === "owner" || role === "admin";
      }

      const windowStart = includeSpend && canViewSpend && monthStart < since ? monthStart : since;

      const agg = (await CreditLedgerModel.aggregate([
        {
          $match: {
            workspaceId: orgId,
            eventType: "ai_run",
            createdDate: { $gte: windowStart },
          },
        },
        {
          $facet: {
            rows: [
              { $match: { createdDate: { $gte: since } } },
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
            ],
            monthSpend:
              includeSpend && canViewSpend
                ? [
                    {
                      $match: {
                        createdDate: { $gte: monthStart },
                        status: "charged",
                      },
                    },
                    { $group: { _id: null, sum: { $sum: "$creditsCharged" } } },
                  ]
                : [{ $match: { _id: { $exists: false } } }],
          },
        },
      ])) as Array<{ rows?: Array<Record<string, any>>; monthSpend?: Array<{ sum?: number }> }>;

    const rowsAgg = Array.isArray(agg?.[0]?.rows) ? agg[0]!.rows! : [];

      // Optional: month-to-date spend (credits * $0.10), owner/admin only.
      let monthSpendCents: number | null = null;
    if (includeSpend && canViewSpend) {
      const monthAgg = Array.isArray(agg?.[0]?.monthSpend) ? agg[0]!.monthSpend! : [];
      const credits =
        typeof monthAgg?.[0]?.sum === "number" && Number.isFinite(monthAgg[0]!.sum!)
          ? Math.max(0, Math.floor(monthAgg[0]!.sum!))
          : 0;
      monthSpendCents = credits * 10;
    }

      return NextResponse.json(
        {
          ok: true,
          days,
          canViewSpend,
          monthSpendCents,
          rows: rowsAgg.map((r) => ({
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


