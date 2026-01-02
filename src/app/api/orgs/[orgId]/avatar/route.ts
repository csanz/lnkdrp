/**
 * API route for `/api/orgs/:orgId/avatar`.
 *
 * Updates the org avatar URL (owner/admin only).
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { OrgModel } from "@/lib/models/Org";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { debugError, debugLog } from "@/lib/debug";
import { resolveActor } from "@/lib/gating/actor";

export const runtime = "nodejs";

function isAllowedUrl(url: string): boolean {
  const u = url.trim();
  if (!u) return false;
  // Keep it tight: require https and a reasonable length.
  if (!u.startsWith("https://")) return false;
  if (u.length > 1024) return false;
  return true;
}

export async function POST(request: Request, ctx: { params: Promise<{ orgId: string }> }) {
  try {
    const { orgId } = await ctx.params;
    const id = decodeURIComponent(orgId || "").trim();
    if (!id || !Types.ObjectId.isValid(id)) return NextResponse.json({ error: "Invalid orgId" }, { status: 400 });

    debugLog(1, "[api/orgs/:orgId/avatar] POST", { orgId: id });
    const actor = await resolveActor(request);
    if (actor.kind !== "user") return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

    const body = (await request.json().catch(() => ({}))) as Partial<{ avatarUrl: string | null }>;
    const avatarUrlRaw = body.avatarUrl;
    const avatarUrl =
      avatarUrlRaw === null ? null : typeof avatarUrlRaw === "string" ? avatarUrlRaw.trim() : null;
    if (avatarUrl !== null && !isAllowedUrl(avatarUrl)) {
      return NextResponse.json({ error: "Invalid avatarUrl" }, { status: 400 });
    }

    await connectMongo();
    const membership = await OrgMembershipModel.findOne({
      orgId: new Types.ObjectId(id),
      userId: new Types.ObjectId(actor.userId),
      isDeleted: { $ne: true },
    })
      .select({ role: 1 })
      .lean();
    const role = membership ? String((membership as { role?: unknown }).role ?? "") : "";
    const canEdit = role === "owner" || role === "admin";
    if (!canEdit) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const updated = await OrgModel.findOneAndUpdate(
      { _id: new Types.ObjectId(id), isDeleted: { $ne: true } },
      { $set: { avatarUrl } },
      { new: true },
    )
      .select({ _id: 1, avatarUrl: 1 })
      .lean();
    if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });

    return NextResponse.json({ ok: true, org: { id, avatarUrl: (updated as any).avatarUrl ?? null } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/orgs/:orgId/avatar] POST failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}




