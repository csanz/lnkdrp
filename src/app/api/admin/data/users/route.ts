/**
 * Admin API route: `GET /api/admin/data/users`
 *
 * Lists users (paged) for admin inspection.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { UserModel } from "@/lib/models/User";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { isProSubscription } from "@/lib/billing/subscriptionState";
import { requireAdmin } from "@/lib/gating/requireAdmin";

export const runtime = "nodejs";



/**
 *
 */
function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
}

/**
 *
 */
function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Which of the listed users is Pro, resolved the way the product resolves it.
 *
 * This row used to report `User.plan`. That field is a pre-workspaces leftover: entitlement moved
 * to the workspace, `getWorkspacePlan` reads the org's `Subscription` row, and nothing writes
 * `User.plan` any more — the Stripe webhook writes `Subscription`, and
 * `POST /api/admin/users/:userId/plan` stopped pretending to write it and now answers 501. With no
 * writer left, the schema default made it the constant `"free"`, so `/a/data/users` showed every
 * paying customer on this deployment as Free while the workspace hub two clicks away showed the
 * same human as Pro with a live subscription. Support read the wrong number and the buttons
 * offered as the remedy could not change it.
 *
 * Two queries for the whole page rather than two per row: the memberships of everyone listed, then
 * the `Subscription` rows of the workspaces those memberships point at. `isProSubscription` is the
 * one authority on what counts as Pro (a pay-as-you-go workspace is `active` in Stripe and still
 * Free-capped), so the query stays broad and the judgement stays in that helper.
 */
async function proUserIds(userIds: Types.ObjectId[]): Promise<Set<string>> {
  const pro = new Set<string>();
  if (!userIds.length) return pro;

  const memberships = await OrgMembershipModel.find({ userId: { $in: userIds }, isDeleted: { $ne: true } })
    .select({ userId: 1, orgId: 1 })
    .lean();

  const orgIds = [
    ...new Set(
      memberships
        .map((m) => String((m as { orgId?: unknown }).orgId ?? ""))
        .filter((id) => Types.ObjectId.isValid(id)),
    ),
  ].map((id) => new Types.ObjectId(id));
  if (!orgIds.length) return pro;

  const subs = await SubscriptionModel.find({ orgId: { $in: orgIds }, isDeleted: { $ne: true } })
    .select({ orgId: 1, status: 1, kind: 1 })
    .lean();
  const proOrgIds = new Set(
    subs
      .filter((s) => isProSubscription(s as { status?: unknown; kind?: unknown }))
      .map((s) => String((s as { orgId?: unknown }).orgId ?? "")),
  );

  for (const m of memberships) {
    const orgId = String((m as { orgId?: unknown }).orgId ?? "");
    if (proOrgIds.has(orgId)) pro.add(String((m as { userId?: unknown }).userId ?? ""));
  }
  return pro;
}

/**
 *
 */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const url = new URL(request.url);
  const limit = Math.min(asPositiveInt(url.searchParams.get("limit")) ?? 50, 200);
  const page = Math.max(asPositiveInt(url.searchParams.get("page")) ?? 1, 1);
  const qRaw = url.searchParams.get("q") ?? "";
  const q = qRaw.trim();
  const sortRaw = (url.searchParams.get("sort") ?? "").trim();
  const orderRaw = (url.searchParams.get("order") ?? "").trim().toLowerCase();
  const roleRaw = (url.searchParams.get("role") ?? "").trim();

  await connectMongo();

  const filter: Record<string, unknown> = {};
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    filter.$or = [{ email: rx }, { name: rx }];
  }
  if (roleRaw) {
    // Keep this strict so "filter by role" is predictable (and avoids weird partial matches).
    const allowed = new Set(["admin", "user", "temp"]);
    if (!allowed.has(roleRaw)) {
      return NextResponse.json({ error: "role must be one of: admin | user | temp" }, { status: 400 });
    }
    filter.role = roleRaw;
  }

  const sortField = sortRaw === "lastLoginAt" ? "lastLoginAt" : "createdAt";
  const sortDir = orderRaw === "asc" ? 1 : -1;

  const total = await UserModel.countDocuments(filter);
  // `plan` is deliberately not selected: see `proUserIds`. The stored field has no writer and would
  // answer "free" for everybody.
  const items = await UserModel.find(filter)
    .sort({ [sortField]: sortDir, _id: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .select({
      email: 1,
      name: 1,
      role: 1,
      isTemp: 1,
      isActive: 1,
      createdAt: 1,
      lastLoginAt: 1,
    })
    .lean();

  const pro = await proUserIds(
    items.map((u) => (u as { _id?: unknown })._id).filter((id): id is Types.ObjectId => id instanceof Types.ObjectId),
  );

  return NextResponse.json({
    ok: true,
    total,
    page,
    limit,
    sort: sortField,
    order: sortDir === 1 ? "asc" : "desc",
    role: roleRaw || null,
    users: items.map((u) => ({
      id: String(u._id),
      email: typeof u.email === "string" ? u.email : null,
      name: typeof u.name === "string" ? u.name : null,
      role: typeof (u as { role?: unknown }).role === "string" ? ((u as { role: string }).role as string) : null,
      // Plan is a property of a workspace, not of a person, and this list has one cell per person:
      // "pro" means Pro in at least one workspace they belong to. The per-workspace answer is the
      // membership list on the user detail page and the workspace hub it links to.
      plan: pro.has(String(u._id)) ? "pro" : "free",
      isTemp: Boolean((u as { isTemp?: unknown }).isTemp),
      isActive: (u as { isActive?: unknown }).isActive !== false,
      createdAt: u.createdAt ? new Date(u.createdAt).toISOString() : null,
      lastLoginAt: u.lastLoginAt ? new Date(u.lastLoginAt).toISOString() : null,
    })),
  });
}




