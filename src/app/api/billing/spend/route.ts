/**
 * API route for `/api/billing/spend` — read/update workspace on-demand spend limit + usage.
 *
 * - GET: returns `{ onDemandMonthlyLimitCents, onDemandUsedCentsThisCycle }`
 * - POST: updates `onDemandMonthlyLimitCents` (cents) for the active workspace (owner/admin only)
 *
 * Primary UI unit is credits; dollars are secondary and only shown in the limit editor.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { resolveActor } from "@/lib/gating/actor";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { WorkspaceCreditBalanceModel } from "@/lib/models/WorkspaceCreditBalance";
import { getCreditsSnapshot } from "@/lib/credits/snapshot";
import { ALLOWED_LIMITS, UNLIMITED_LIMIT_CENTS } from "@/lib/billing/limits";
import { USD_CENTS_PER_CREDIT } from "@/lib/billing/pricing";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toNonNegativeInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i < 0) return null;
  return i;
}

function normalizeLimitCents(v: unknown): number | null {
  const n = toNonNegativeInt(v);
  if (n === null) return null;
  // Hard cap for safety even if client sends something extreme.
  return Math.min(n, UNLIMITED_LIMIT_CENTS);
}

export async function GET(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActor(request);
    try {
      if (actor.kind !== "user") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      if (!Types.ObjectId.isValid(actor.orgId)) return NextResponse.json({ error: "Invalid org" }, { status: 400 });

      await connectMongo();
      const orgId = new Types.ObjectId(actor.orgId);
      const bal = await WorkspaceCreditBalanceModel.findOne({ workspaceId: orgId })
        .select({ onDemandEnabled: 1, onDemandMonthlyLimitCents: 1 })
        .lean();
      const limitCents =
        typeof (bal as any)?.onDemandMonthlyLimitCents === "number" && Number.isFinite((bal as any).onDemandMonthlyLimitCents)
          ? Math.max(0, Math.floor((bal as any).onDemandMonthlyLimitCents))
          : 0;
      const enabled = Boolean((bal as any)?.onDemandEnabled) && limitCents > 0;

      // Usage is derived from the credit ledger within the current billing cycle window.
      const snap = await getCreditsSnapshot({ workspaceId: actor.orgId });
      const centsPerCredit = USD_CENTS_PER_CREDIT;
      const usedCents = Math.max(0, Math.floor(snap.onDemandUsedCreditsThisCycle)) * centsPerCredit;

      return NextResponse.json(
        {
          ok: true,
          onDemandEnabled: enabled,
          onDemandMonthlyLimitCents: enabled ? limitCents : 0,
          onDemandUsedCentsThisCycle: usedCents,
        },
        { headers: { "cache-control": "no-store" } },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  });
}

export async function POST(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActor(request);
    try {
      if (actor.kind !== "user") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      if (!Types.ObjectId.isValid(actor.userId)) return NextResponse.json({ error: "Invalid user" }, { status: 400 });
      if (!Types.ObjectId.isValid(actor.orgId)) return NextResponse.json({ error: "Invalid org" }, { status: 400 });

      const body = (await request.json().catch(() => null)) as { spendLimitCents?: unknown } | null;
      const limitCents = normalizeLimitCents(body?.spendLimitCents);
      if (limitCents === null) return NextResponse.json({ error: "Invalid spendLimitCents" }, { status: 400 });

      // Enforce allow-list + "custom": allow any positive value up to UNLIMITED (inclusive),
      // but keep a tiny guardrail so "custom" isn't accidentally set to $0 unless explicitly chosen.
      const allowed = (ALLOWED_LIMITS as readonly number[]).includes(limitCents);
      const customOk = limitCents > 0 && limitCents <= UNLIMITED_LIMIT_CENTS;
      if (!allowed && !customOk) {
        return NextResponse.json({ error: "Spend limit not allowed" }, { status: 400 });
      }

      await connectMongo();
      const orgId = new Types.ObjectId(actor.orgId);
      const userId = new Types.ObjectId(actor.userId);
      const membership = await OrgMembershipModel.findOne({ orgId, userId, isDeleted: { $ne: true } })
        .select({ role: 1 })
        .lean();
      const role = typeof (membership as any)?.role === "string" ? String((membership as any).role) : "";
      if (role !== "owner" && role !== "admin") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }

      const enabled = limitCents > 0;
      await WorkspaceCreditBalanceModel.updateOne(
        { workspaceId: orgId },
        { $set: { onDemandEnabled: enabled, onDemandMonthlyLimitCents: enabled ? limitCents : 0 } },
        { upsert: true },
      );

      return NextResponse.json(
        { ok: true, onDemandEnabled: enabled, onDemandMonthlyLimitCents: enabled ? limitCents : 0 },
        { headers: { "cache-control": "no-store" } },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  });
}


