/**
 * API route for `/api/orgs`.
 *
 * Lists orgs available to the signed-in user and allows creating a new team org.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { OrgModel, ensurePersonalOrgForUserId } from "@/lib/models/Org";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { UserModel } from "@/lib/models/User";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { debugError, debugLog } from "@/lib/debug";
import { activeOrgCandidateOrder, resolveActor, tryResolveAuthUserId } from "@/lib/gating/actor";
import { ACTIVE_ORG_COOKIE } from "@/lib/orgs/activeOrgCookie";
import { errorJson } from "@/lib/http/errorResponse";
import {
  FREE_TEAM_WORKSPACES,
  UPGRADE_URL,
  getWorkspacePlan,
  planLimitResponse,
} from "@/lib/billing/planLimits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    return await withMongoRequestLogging(request, async () => {
      const session = await tryResolveAuthUserId(request);
      if (!session?.userId) {
        return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
      }

      const cookieHeader = request.headers.get("cookie") ?? "";
      const cookieActiveOrgId = (() => {
        try {
          const parts = cookieHeader.split(";").map((s) => s.trim()).filter(Boolean);
          for (const p of parts) {
            const idx = p.indexOf("=");
            if (idx < 0) continue;
            const k = p.slice(0, idx).trim();
            if (k !== ACTIVE_ORG_COOKIE) continue;
            return decodeURIComponent(p.slice(idx + 1)).trim();
          }
          return "";
        } catch {
          return "";
        }
      })();

      await connectMongo();
      const userId = new Types.ObjectId(session.userId);

    // Hot-path optimization: most users already have memberships (including a personal org),
    // so avoid the extra ensurePersonalOrgForUserId() DB work unless it's actually needed.
    let memberships = await OrgMembershipModel.find({ userId, isDeleted: { $ne: true } })
      .select({ orgId: 1, role: 1 })
      .lean();
    let ensuredPersonalOrgId: string | null = null;
    if (!memberships.length) {
      const { orgId: personalOrgIdObjectId } = await ensurePersonalOrgForUserId({ userId });
      ensuredPersonalOrgId = String(personalOrgIdObjectId);
      memberships = await OrgMembershipModel.find({ userId, isDeleted: { $ne: true } })
        .select({ orgId: 1, role: 1 })
        .lean();
    }

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
    const claimActiveOrgId = typeof session.activeOrgId === "string" ? session.activeOrgId.trim() : "";
    const personalOrgId =
      ensuredPersonalOrgId ||
      (orgs.find((o) => Boolean((o as unknown as { personalForUserId?: unknown }).personalForUserId))?._id
        ? String(orgs.find((o) => Boolean((o as unknown as { personalForUserId?: unknown }).personalForUserId))!._id)
        : "") ||
      "";
    // Which workspace is active is decided in exactly one place — `activeOrgCandidateOrder` in
    // src/lib/gating/actor.ts — and confirmed here against the membership map this route has
    // already built, rather than with a second round of lookups.
    //
    // The order used to be written out again here, with the JWT claim ranked *above* the stored
    // workspace. A JWT is issued at sign-in and lives for weeks, so on a device with no cookie the
    // switcher named the workspace the token remembered while `POST /api/docs` — which goes through
    // the resolver — created the document in the workspace the person had actually last chosen, and
    // published a live share link for it there. The comment above this block claimed the two agreed.
    const savedActiveOrgId = await (async () => {
      const u = (await UserModel.findOne({ _id: userId }).select({ "metadata.activeOrgId": 1 }).lean()) as {
        metadata?: { activeOrgId?: unknown };
      } | null;
      return typeof u?.metadata?.activeOrgId === "string" ? u.metadata.activeOrgId.trim() : "";
    })();
    let activeOrgId =
      activeOrgCandidateOrder({
        cookieOrgId: cookieActiveOrgId,
        metadataOrgId: savedActiveOrgId,
        claimOrgId: claimActiveOrgId,
      }).find((candidate) => candidate === personalOrgId || membershipByOrgId.has(candidate)) ?? "";
    if (!activeOrgId) activeOrgId = personalOrgId || (orgs[0]?._id ? String(orgs[0]._id) : "");

    // Guardrail: if there are multiple personal orgs for this user (shouldn't happen),
    // return only one to avoid confusing duplicate "Personal" entries in the UI.
    const personal = orgs.filter((o) => String((o as { type?: unknown }).type) === "personal");
    if (personal.length > 1) {
      // Prefer the one matching the user's canonical personal org id.
      const keepId = personalOrgId || String(personal[0]!._id);
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

      const payload = {
      activeOrgId,
      orgs: orgs.map((o) => ({
        id: String(o._id),
        type: String((o as unknown as { type?: unknown }).type ?? "team"),
        name: String(o.name ?? ""),
        slug: (o as unknown as { slug?: unknown }).slug ?? null,
        avatarUrl: (o as unknown as { avatarUrl?: unknown }).avatarUrl ?? null,
        role: roleByOrgId.get(String(o._id)) ?? "member",
      })),
      };

      return NextResponse.json(payload, { headers: { "cache-control": "no-store" } });
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/orgs] GET failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/**
 * The team workspaces this user owns — memberships with `role: "owner"` whose org is a live team.
 *
 * Personal workspaces are excluded by the `type` filter: everyone has exactly one, nobody chose it,
 * and counting it would refuse the very first team workspace a Free user creates.
 */
async function ownedTeamWorkspaceIds(userId: Types.ObjectId): Promise<Types.ObjectId[]> {
  const memberships = await OrgMembershipModel.find({ userId, role: "owner", isDeleted: { $ne: true } })
    .select({ orgId: 1 })
    .lean();
  const orgIds = memberships
    .map((m) => (m as { orgId?: unknown }).orgId)
    .filter((id): id is Types.ObjectId => id instanceof Types.ObjectId || Types.ObjectId.isValid(String(id)))
    .map((id) => new Types.ObjectId(String(id)));
  if (!orgIds.length) return [];
  const orgs = await OrgModel.find({ _id: { $in: orgIds }, type: "team", isDeleted: { $ne: true } })
    .select({ _id: 1 })
    .lean();
  return orgs.map((o) => new Types.ObjectId(String((o as { _id: unknown })._id)));
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
    const userId = new Types.ObjectId(String(actor.userId));

    /**
     * How many team workspaces this person may own.
     *
     * Every other plan limit in the product is counted per workspace — ten shared documents, two
     * project, no collaborators — and creating a workspace was free, instant and unlimited. So the
     * Free caps were only ever "per workspace you happen to have", and the way around all of them
     * was the New workspace button. This is the limit that makes the rest mean what they say.
     *
     * Pro is unlimited, and "Pro" here means the person, not the workspace they are creating (which
     * does not exist yet): if any workspace they already own is on Pro, they are a paying customer
     * and this is not the place to stop them. Owned workspaces are few — the Free ceiling is one —
     * so the plan reads are bounded.
     *
     * Grandfathering is deliberate: someone already over the line keeps every workspace they have
     * and is only refused the next one. Taking a workspace away from an existing user to enforce a
     * cap introduced after they made it would be the wrong trade.
     */
    const ownedTeamOrgIds = await ownedTeamWorkspaceIds(userId);
    if (ownedTeamOrgIds.length >= FREE_TEAM_WORKSPACES) {
      const plans = await Promise.all(ownedTeamOrgIds.map((id) => getWorkspacePlan(id)));
      if (!plans.some((plan) => plan === "pro")) {
        return planLimitResponse({
          ok: false,
          code: "plan_limit",
          limit: "team_workspaces",
          used: ownedTeamOrgIds.length,
          requested: 1,
          max: FREE_TEAM_WORKSPACES,
          grace: null,
          upgradeUrl: UPGRADE_URL,
          message:
            FREE_TEAM_WORKSPACES === 1
              ? "Free accounts can have one team workspace. Upgrade to Pro to create another."
              : `Free accounts can have ${FREE_TEAM_WORKSPACES} team workspaces. Upgrade to Pro to create another.`,
        });
      }
    }

    const base = slugify(slugRaw || name);
    const slug = await ensureUniqueOrgSlug(base);

    const now = new Date();
    const created = await OrgModel.create({
      type: "team",
      // No `personalForUserId`: the unique index is partial on real user ids, and an explicit null
      // made the second team workspace in a database fail with E11000.
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
      { status: 201, headers: { "cache-control": "no-store" } },
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
    // Anything that reaches here is ours, not the caller's — the one client error this route
    // produces (a slug collision) is answered above. The raw message used to go to the browser and
    // `debugError` only logged it when DEBUG_LEVEL was set, which it is not in production.
    return errorJson(err, {
      status: 500,
      publicMessage: "Could not create the workspace.",
      context: "[api/orgs] POST failed",
    });
  }
}


