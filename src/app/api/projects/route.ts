/**
 * API route for `/api/projects`.
 *
 * Lists and creates projects (each gets a public `/p/:shareId`).
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { ProjectModel } from "@/lib/models/Project";
import { debugLog } from "@/lib/debug";
import { applyTempUserHeaders, resolveActor, tryResolveUserActorFastWithPersonalOrg } from "@/lib/gating/actor";
import { newShareId } from "@/lib/crypto/randomBase62";
import { forbidUnlessOrgRole } from "@/lib/orgs/requireOrgEditor";
import { recordActivity } from "@/lib/activity/log";
import { checkLimit, planLimitResponse } from "@/lib/billing/planLimits";
import { authOrRateLimitResponse, errorJson } from "@/lib/http/errorResponse";
import { liveProjectFilter } from "@/lib/projects/scope";
import { ProjectMembershipModel } from "@/lib/models/ProjectMembership";
import { projectMembershipChanged } from "@/lib/projects/lockScope";
import { forbidWaitlisted } from "@/lib/gating/waitlist";

const MAX_PROJECT_NAME_LENGTH = 80;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Creates a URL-friendly slug from user-provided text.
 *
 * Exists to produce stable project URLs while keeping slugs predictable and safe.
 * Note: callers still must ensure uniqueness within a workspace.
 */
/**
 * True when another live project in the workspace has this name, ignoring letter case. The unique
 * index is case-sensitive, so "Press kit" and "press KIT" both went in and could not be told apart
 * in any list.
 */
async function projectNameTaken(orgId: Types.ObjectId, name: string, exceptId?: unknown): Promise<boolean> {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hit = await ProjectModel.exists({
    orgId,
    name: { $regex: `^${escaped}$`, $options: "i" },
    isDeleted: { $ne: true },
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  });
  return Boolean(hit);
}

function slugify(input: string) {
  return input
    .trim()
    // Fold accents to their base letter ("Série" -> "serie") instead of cutting the word in two.
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * Finds an available project slug within the workspace (and legacy personal scope when relevant).
 *
 * Exists to avoid slug collisions without requiring a client round-trip. May issue multiple DB reads.
 * Returns a best-effort unique slug; falls back to timestamp suffix after many attempts.
 */
async function ensureUniqueSlug(opts: { orgId: Types.ObjectId; legacyUserId?: Types.ObjectId; base: string }) {
  const base = opts.base || "project";
  // Try base, then base-2, base-3, ...
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const exists = await ProjectModel.exists({
      $or: [
        { orgId: opts.orgId, slug: candidate },
        ...(opts.legacyUserId
          ? [
              {
                userId: opts.legacyUserId,
                slug: candidate,
                $or: [{ orgId: { $exists: false } }, { orgId: null }],
              },
            ]
          : []),
      ],
    });
    if (!exists) return candidate;
  }
  // Last resort: include timestamp suffix.
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * Generates a short public identifier for `/p/:shareId`.
 *
 * This is not secret; it is a URL slug used for public share paths.
 */
function newProjectShareId() {
  return newShareId();
}

/**
 * `GET /api/projects`
 *
 * Lists non-request projects for the active workspace (paged), with optional search and `lite=1` mode.
 * Side effects: may best-effort backfill legacy `orgId`/`slug` (skipped for `lite=1` and `sidebar=1`).
 * Errors: 400 for unexpected failures; auth failures surface via actor resolution.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    const pageRaw = url.searchParams.get("page");
    const qRaw = url.searchParams.get("q") ?? "";
    const lite = url.searchParams.get("lite") === "1";
    const sidebar = url.searchParams.get("sidebar") === "1";
    // `Number(null)` is 0, which clamped to 1: a request without `limit` got one item, not 25.
    const limitNum = limitRaw ? Number(limitRaw) : NaN;
    const limit = Math.max(1, Math.min(50, Number.isFinite(limitNum) && limitNum > 0 ? Math.floor(limitNum) : 25));
    const page = Math.max(1, Number.isFinite(Number(pageRaw)) ? Number(pageRaw) : 1);
    const q = qRaw.trim();

    debugLog(2, "[api/projects] GET", { limit, page, lite, sidebar, q: q ? "[redacted]" : "" });
    const actor =
      (lite || sidebar ? await tryResolveUserActorFastWithPersonalOrg(request) : null) ?? (await resolveActor(request));
    await connectMongo();

    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;

    // Projects endpoint returns ONLY non-request projects.
    // Requests are listed via `/api/requests` to enforce strict separation.
    // The live, non-request projects this caller may see (src/lib/projects/scope.ts), plus the
    // legacy personal scope, which only ever widens what a personal workspace sees. The plan cap
    // counts through `allProjectsFilter` instead, because a locked room still occupies a slot; the
    // two now differ by exactly the caller's visibility clause and nothing else.
    const { orgId: _scopedOrgId, ...liveProject } = await liveProjectFilter(orgId, actor.userId, request);
    const filter: Record<string, unknown> = {
      ...(allowLegacyByUserId
        ? {
            $or: [
              { orgId },
              { userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
            ],
          }
        : { orgId }),
      ...liveProject,
    };
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      (filter.$and as Array<Record<string, unknown>>).push({ $or: [{ name: rx }, { description: rx }] });
    }

    // `lite=1` is used by doc page menus where totals aren't needed.
    // `sidebar=1` is used by the app left sidebar and needs totals for "See more" affordances.
    const total = lite && !sidebar ? null : await ProjectModel.countDocuments(filter);
    // Stable ordering: when `updatedDate` ties (or is null), add a deterministic tiebreaker.
    // Without this, MongoDB is free to return ties in arbitrary order, causing UI "flip" on refresh.
    // Perf: `lite=1` is used by small pickers (doc actions menu) and must be as cheap as possible.
    // Only include fields those UIs actually need (id + name + slug for display/linking).
    // `visibility` is in both shapes, `lite` included: the pickers are exactly where a locked room
    // needs its padlock, and a list that named rooms without saying which are private would make
    // "Add to a data room" read as though everything in it is shared with the workspace.
    const select = lite
      ? "_id name slug visibility"
      : {
          _id: 1,
          shareId: 1,
          name: 1,
          slug: 1,
          description: 1,
          docCount: 1,
          autoAddFiles: 1,
          visibility: 1,
          updatedDate: 1,
          createdDate: 1,
        };

    const projects = await ProjectModel.find(filter)
      .select(select)
      .sort({ updatedDate: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // Best-effort: backfill slug for older projects.
    // IMPORTANT: skip this work for `lite=1` callers (used by doc page menus), so opening
    // the project picker never pays a migration/backfill tax.
    // Also skip for `sidebar=1` (the left sidebar polls frequently and must not pay migration costs).
    if (!lite && !sidebar) {
      for (const p of projects) {
        // Best-effort: backfill orgId for legacy personal projects so org scoping works.
        const pOrgId = (p as unknown as { orgId?: unknown }).orgId;
        if (allowLegacyByUserId && !pOrgId) {
          try {
            await ProjectModel.updateOne(
              { _id: p._id, userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
              { $set: { orgId } },
              // Avoid bumping `updatedDate` for backfills; otherwise list order can "flip" on refresh.
              { timestamps: false },
            );
            (p as unknown as { orgId?: Types.ObjectId }).orgId = orgId;
          } catch {
            // ignore; best-effort
          }
        }

        const s = (p as unknown as { slug?: unknown }).slug;
        if (typeof s === "string" && s.trim()) continue;
        const base = slugify((p as unknown as { name?: unknown }).name ? String((p as { name?: unknown }).name) : "");
        const slug = await ensureUniqueSlug({ orgId, legacyUserId: allowLegacyByUserId ? legacyUserId : undefined, base });
        await ProjectModel.updateOne(
          {
            // `$and`, not a spread: the legacy tenant clause is its own `$or`, and a second `$or`
            // key in the same object literal replaced it, dropping the workspace filter.
            $and: [
              { _id: p._id },
              allowLegacyByUserId ? { $or: [{ orgId }, { userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] }] } : { orgId },
              { $or: [{ slug: { $exists: false } }, { slug: null }, { slug: "" }] },
            ],
          },
          { $set: { slug } },
          // Avoid bumping `updatedDate` for backfills; otherwise list order can "flip" on refresh.
          { timestamps: false },
        );
        (p as unknown as { slug?: string }).slug = slug;
      }
    }

    return applyTempUserHeaders(
      NextResponse.json(
        {
          total,
          page,
          limit,
          projects: projects.map((p) => ({
            id: String(p._id),
            shareId: (p as unknown as { shareId?: unknown }).shareId ?? null,
            name: p.name ?? "",
            slug: (p as unknown as { slug?: string }).slug ?? "",
            description: p.description ?? "",
            isRequest: false,
            docCount: (function () {
              const raw = (p as unknown as { docCount?: unknown }).docCount;
              return Number.isFinite(raw) ? Number(raw) : 0;
            })(),
            autoAddFiles: Boolean((p as unknown as { autoAddFiles?: unknown }).autoAddFiles),
            visibility: (p as unknown as { visibility?: unknown }).visibility === "locked" ? "locked" : "workspace",
            updatedDate: p.updatedDate ? new Date(p.updatedDate).toISOString() : null,
            createdDate: p.createdDate ? new Date(p.createdDate).toISOString() : null,
          })),
        },
        // Allow very short-lived private caching for `lite=1` pickers (cuts perceived latency).
        // Full lists / sidebar calls remain no-store to keep counts fresh.
        {
          headers: {
            "cache-control": lite && !sidebar && !q ? "private, max-age=15" : "no-store",
          },
        },
      ),
      actor,
    );
  } catch (err) {
    const authOrLimited = authOrRateLimitResponse(err);
    if (authOrLimited) return authOrLimited;
    return errorJson(err, { status: 500, publicMessage: "Could not load projects", context: "[api/projects] GET failed" });
  }
}

/**
 * `POST /api/projects`
 *
 * Creates a new non-request project (name/description/autoAddFiles) with a unique slug and shareId.
 * Plan limits: Free workspaces are capped on non-request projects (request repos are not counted);
 * inside a grace window the create succeeds with `planWarning` in the body.
 * Errors: 400 for validation/unexpected failures, 402 (`code: "plan_limit"`) when the project cap
 * blocks, 409 when a duplicate name constraint is hit.
 */
export async function POST(request: Request) {
  try {
    debugLog(1, "[api/projects] POST");
    const actor = await resolveActor(request);
    // Viewers can read a workspace but must not create projects in it.
    const forbidden = await forbidUnlessOrgRole(actor);
    if (forbidden) return forbidden;
    // The queue is a gate on the API, not a redirect on one page layout. `(app)/layout.tsx` sent a
    // queued account to /waitlist, which is a decoration: the browser could still call this route
    // directly, and so could an `lnk_` key. See src/lib/gating/waitlist.ts.
    const queued = await forbidWaitlisted(actor, "create a project");
    if (queued) return queued;
    const body = (await request.json().catch(() => ({}))) as Partial<{
      name: string;
      description: string;
      autoAddFiles: boolean;
      locked: boolean;
    }>;

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const autoAddFiles = typeof body.autoAddFiles === "boolean" ? body.autoAddFiles : false;
    // Create it as a private data room (docs/prds/lnkdrp-locked-projects.md, decision 31's create
    // half). Nothing in the UI sends this yet; the MCP's `lnkdrp_create_project` will, because an
    // agent creating something LESS visible than the default is not a risk worth a refusal.
    const locked = body.locked === true;
    if (!name) return NextResponse.json({ error: "Project name is required" }, { status: 400 });
    // Same cap PATCH enforces; create had none, so a rename could fail on a name create accepted.
    if (name.length > MAX_PROJECT_NAME_LENGTH) {
      return NextResponse.json({ error: `Project name must be ${MAX_PROJECT_NAME_LENGTH} characters or less` }, { status: 400 });
    }

    await connectMongo();
    const orgId = new Types.ObjectId(actor.orgId);
    const userId = new Types.ObjectId(actor.userId);

    // Free plan: project cap (non-request projects only).
    const limitCheck = await checkLimit(actor.orgId, "projects");
    if (!limitCheck.ok) {
      return applyTempUserHeaders(planLimitResponse(limitCheck, { orgId: actor.orgId, userId: actor.userId, actorKind: actor.kind, request }), actor);
    }

    if (await projectNameTaken(orgId, name)) {
      return NextResponse.json({ error: "A project with that name already exists" }, { status: 409 });
    }
    const base = slugify(name);
    const slug = await ensureUniqueSlug({
      orgId,
      legacyUserId: actor.orgId === actor.personalOrgId ? userId : undefined,
      base,
    });
    const created = await ProjectModel.create({
      orgId,
      userId,
      shareId: newProjectShareId(),
      name,
      slug,
      description,
      autoAddFiles,
      ...(locked ? { visibility: "locked", lockedAt: new Date(), lockedByUserId: userId } : {}),
    });
    const p = (Array.isArray(created) ? created[0] : created) as typeof created;
    const projectId = (p as unknown as { _id: Types.ObjectId })._id;

    if (locked) {
      // Seat the creator as the first member, or the room is invisible to everybody including them.
      // There is no owner bypass anywhere in this feature (decision 21), so an empty locked room is
      // not a room with a caretaker, it is a room nobody can open until break-glass exists. If the
      // grant cannot be written the project is deleted again and the create fails: it is seconds
      // old and holds no documents and no links, so nothing is lost, and a caller who retries gets
      // their name back instead of a 409 against a room they cannot see.
      try {
        await ProjectMembershipModel.create({
          orgId,
          projectId,
          userId,
          role: "editor",
          via: "creator",
          addedByUserId: userId,
        });
        // The caller lists their projects immediately after this, and the grant cache would
        // otherwise serve them the empty answer it read seconds ago and hide the room they just
        // made.
        projectMembershipChanged({ orgId, userId });
      } catch (grantErr) {
        debugLog(1, "[api/projects] POST could not seat the creator in a locked room", {
          project: String(projectId),
        });
        await ProjectModel.deleteOne({ _id: projectId }).catch(() => undefined);
        throw grantErr;
      }
    }
    void recordActivity({
      orgId: actor.orgId,
      userId: actor.userId,
      actorKind: actor.kind,
      type: "project.created",
      projectId,
      title: name,
      meta: { projectName: name },
      request,
    });

    return applyTempUserHeaders(
      NextResponse.json(
        {
          project: {
            id: String(projectId),
            shareId: (p as unknown as { shareId?: unknown }).shareId ?? null,
            name,
            slug,
            description,
            isRequest: false,
            docCount: (function () {
              const raw = (p as unknown as { docCount?: unknown }).docCount;
              return Number.isFinite(raw) ? Number(raw) : 0;
            })(),
            autoAddFiles,
            visibility: locked ? "locked" : "workspace",
          },
          ...(limitCheck.warning ? { planWarning: limitCheck.warning } : {}),
        },
        { status: 201 },
      ),
      actor,
    );
  } catch (err) {
    const authOrLimited = authOrRateLimitResponse(err);
    if (authOrLimited) return authOrLimited;
    // Surface a clean message for duplicate-name per user.
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: number }).code === 11000
    ) {
      return NextResponse.json({ error: "A project with that name already exists" }, { status: 409 });
    }
    return errorJson(err, { status: 500, publicMessage: "Could not create the project", context: "[api/projects] POST failed" });
  }
}




