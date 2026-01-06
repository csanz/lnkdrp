/**
 * API route for `/api/orgs`.
 *
 * Lists orgs available to the signed-in user and allows creating a new team org.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { OrgModel } from "@/lib/models/Org";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { debugError, debugLog } from "@/lib/debug";
import { resolveActor } from "@/lib/gating/actor";

export const runtime = "nodejs";

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

async function ensureUniqueOrgSlug(base: string): Promise<string> {
  const b = base || "org";
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? b : `${b}-${i + 1}`;
    const exists = await OrgModel.exists({ slug: candidate, isDeleted: { $ne: true } });
    if (!exists) return candidate;
  }
  return `${b}-${Date.now().toString(36)}`;
}

export async function GET(request: Request) {
  try {
    debugLog(2, "[api/orgs] GET");
    const actor = await resolveActor(request);
    if (actor.kind !== "user") {
      return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
    }

    await connectMongo();
    const userId = new Types.ObjectId(actor.userId);

    // Note: `resolveActor()` already ensures the user has a personal org + membership (best-effort).

    const memberships = await OrgMembershipModel.find({ userId, isDeleted: { $ne: true } })
      .select({ orgId: 1, role: 1 })
      .lean();

    // Deduplicate by orgId in case the collection has legacy duplicates (unique index may not exist yet).
    const membershipByOrgId = new Map<string, { orgId: Types.ObjectId; role: string }>();
    for (const m of memberships) {
      const oid = (m as unknown as { orgId?: unknown }).orgId;
      const role = String((m as unknown as { role?: unknown }).role ?? "member");
      if (!oid) continue;
      const key = String(oid);
      if (!membershipByOrgId.has(key)) {
        membershipByOrgId.set(key, { orgId: oid as Types.ObjectId, role });
      }
    }
    const orgIds = Array.from(membershipByOrgId.values()).map((m) => m.orgId);
    const orgs = orgIds.length
      ? await OrgModel.find({ _id: { $in: orgIds }, isDeleted: { $ne: true } })
          .select({ _id: 1, type: 1, name: 1, slug: 1, avatarUrl: 1, personalForUserId: 1 })
          .lean()
      : [];

    const roleByOrgId = new Map<string, string>();
    for (const [k, v] of membershipByOrgId.entries()) roleByOrgId.set(k, v.role);

    // Sort: stable (personal first, then name).
    // UX: do NOT sort "active org first" because it makes the workspace switcher reorder itself
    // when switching, which breaks spatial memory.
    const activeOrgId = actor.orgId;

    // Guardrail: if there are multiple personal orgs for this user (shouldn't happen),
    // return only one to avoid confusing duplicate "Personal" entries in the UI.
    const personal = orgs.filter((o) => String((o as { type?: unknown }).type) === "personal");
    if (personal.length > 1) {
      // Prefer the one matching the user's canonical personal org id.
      const keepId = actor.personalOrgId;
      const kept = orgs.find((o) => String(o._id) === keepId) ?? personal[0]!;
      const keptId = String(kept._id);
      const filtered = orgs.filter((o) => {
        const isPersonal = String((o as { type?: unknown }).type) === "personal";
        return !isPersonal || String(o._id) === keptId;
      });
      orgs.length = 0;
      orgs.push(...filtered);
    }

    orgs.sort((a, b) => {
      const aPersonal = Boolean((a as unknown as { personalForUserId?: unknown }).personalForUserId);
      const bPersonal = Boolean((b as unknown as { personalForUserId?: unknown }).personalForUserId);
      if (aPersonal && !bPersonal) return -1;
      if (bPersonal && !aPersonal) return 1;
      const byName = String(a.name ?? "").localeCompare(String(b.name ?? ""));
      if (byName) return byName;
      // Stable tie-breaker (rare).
      return String(a._id).localeCompare(String(b._id));
    });

    return NextResponse.json({
      activeOrgId,
      orgs: orgs.map((o) => ({
        id: String(o._id),
        type: String((o as unknown as { type?: unknown }).type ?? "team"),
        name: String(o.name ?? ""),
        slug: (o as unknown as { slug?: unknown }).slug ?? null,
        avatarUrl: (o as unknown as { avatarUrl?: unknown }).avatarUrl ?? null,
        role: roleByOrgId.get(String(o._id)) ?? "member",
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/orgs] GET failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    debugLog(1, "[api/orgs] POST");
    const actor = await resolveActor(request);
    if (actor.kind !== "user") {
      return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as Partial<{ name: string; slug: string }>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const slugRaw = typeof body.slug === "string" ? body.slug.trim() : "";
    if (!name) return NextResponse.json({ error: "Org name is required" }, { status: 400 });

    await connectMongo();
    const userId = new Types.ObjectId(actor.userId);
    const base = slugify(slugRaw || name);
    const slug = await ensureUniqueOrgSlug(base);

    const now = new Date();
    const created = await OrgModel.create({
      type: "team",
      personalForUserId: null,
      name,
      avatarUrl: null,
      slug,
      createdByUserId: userId,
      isDeleted: false,
      createdDate: now,
      updatedDate: now,
    });
    const org = (Array.isArray(created) ? created[0] : created) as typeof created;
    const orgId = String((org as unknown as { _id: Types.ObjectId })._id);

    await OrgMembershipModel.create({
      orgId: new Types.ObjectId(orgId),
      userId,
      role: "owner",
      isDeleted: false,
      createdDate: now,
      updatedDate: now,
    });

    return NextResponse.json(
      {
        org: {
          id: orgId,
          type: "team",
          name,
          slug,
          role: "owner",
        },
      },
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // Likely slug collision (unique index); surface a clean message.
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: number }).code === 11000
    ) {
      return NextResponse.json({ error: "An org with that slug already exists" }, { status: 409 });
    }
    debugError(1, "[api/orgs] POST failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


