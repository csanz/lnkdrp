/**
 * API route for `/api/projects`.
 *
 * Lists and creates projects (each gets a public `/p/:shareId`).
 */
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { ProjectModel } from "@/lib/models/Project";
import { debugError, debugLog } from "@/lib/debug";
import { applyTempUserHeaders, resolveActor, tryResolveUserActorFast } from "@/lib/gating/actor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/**
 * Random Base62 (uses randomBytes, max, ceil).
 */


function randomBase62(length: number): string {
  let out = "";
  while (out.length < length) {
    const remaining = length - out.length;
    const buf = crypto.randomBytes(Math.max(8, Math.ceil(remaining * 1.25)));
    for (const b of buf) {
      // 62 * 4 = 248, so values 0..247 map evenly to base62.
      if (b < 248) out += BASE62_ALPHABET[b % 62];
      if (out.length >= length) break;
    }
  }
  return out;
}
/**
 * Slugify (uses slice, replace, toLowerCase).
 */


function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
/**
 * Ensure Unique Slug (uses exists, toString, now).
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
 * Generate a short public identifier for `/p/:shareId`.
 */
function newProjectShareId() {
  // Alphanumeric only (no dashes/special chars) for friendlier share URLs.
  return randomBase62(12);
}
/**
 * Handle GET requests.
 */


export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    const pageRaw = url.searchParams.get("page");
    const qRaw = url.searchParams.get("q") ?? "";
    const lite = url.searchParams.get("lite") === "1";
    const limit = Math.max(
      1,
      Math.min(50, Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 25),
    );
    const page = Math.max(1, Number.isFinite(Number(pageRaw)) ? Number(pageRaw) : 1);
    const q = qRaw.trim();

    debugLog(2, "[api/projects] GET", { limit, page, lite, q: q ? "[redacted]" : "" });
    const actor = (lite ? await tryResolveUserActorFast(request) : null) ?? (await resolveActor(request));
    await connectMongo();

    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;

    // Projects endpoint returns ONLY non-request projects.
    // Requests are listed via `/api/requests` to enforce strict separation.
    const filter: Record<string, unknown> = {
      ...(allowLegacyByUserId
        ? {
            $or: [
              { orgId },
              { userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
            ],
          }
        : { orgId }),
      $and: [
        { $or: [{ isRequest: { $exists: false } }, { isRequest: { $ne: true } }] },
        { $or: [{ requestUploadToken: { $exists: false } }, { requestUploadToken: null }, { requestUploadToken: "" }] },
      ],
    };
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      (filter.$and as Array<Record<string, unknown>>).push({ $or: [{ name: rx }, { description: rx }] });
    }

    const total = lite ? null : await ProjectModel.countDocuments(filter);
    // Stable ordering: when `updatedDate` ties (or is null), add a deterministic tiebreaker.
    // Without this, MongoDB is free to return ties in arbitrary order, causing UI "flip" on refresh.
    const projects = await ProjectModel.find(filter)
      .select({
        _id: 1,
        shareId: 1,
        name: 1,
        slug: 1,
        description: 1,
        docCount: 1,
        autoAddFiles: 1,
        updatedDate: 1,
        createdDate: 1,
      })
      .sort({ updatedDate: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // Best-effort: backfill slug for older projects.
    // IMPORTANT: skip this work for `lite=1` callers (used by doc page menus), so opening
    // the project picker never pays a migration/backfill tax.
    if (!lite) {
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
            _id: p._id,
            ...(allowLegacyByUserId
              ? {
                  $or: [
                    { orgId },
                    { userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
                  ],
                }
              : { orgId }),
            $or: [{ slug: { $exists: false } }, { slug: null }, { slug: "" }],
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
            updatedDate: p.updatedDate ? new Date(p.updatedDate).toISOString() : null,
            createdDate: p.createdDate ? new Date(p.createdDate).toISOString() : null,
          })),
        },
        { headers: { "cache-control": "no-store" } },
      ),
      actor,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/projects] GET failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
/**
 * Handle POST requests.
 */


export async function POST(request: Request) {
  try {
    debugLog(1, "[api/projects] POST");
    const actor = await resolveActor(request);
    const body = (await request.json().catch(() => ({}))) as Partial<{
      name: string;
      description: string;
      autoAddFiles: boolean;
    }>;

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const autoAddFiles = typeof body.autoAddFiles === "boolean" ? body.autoAddFiles : false;
    if (!name) return NextResponse.json({ error: "Project name is required" }, { status: 400 });

    await connectMongo();
    const orgId = new Types.ObjectId(actor.orgId);
    const userId = new Types.ObjectId(actor.userId);
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
    });
    const p = (Array.isArray(created) ? created[0] : created) as typeof created;

    return applyTempUserHeaders(
      NextResponse.json(
        {
          project: {
            id: String((p as unknown as { _id: Types.ObjectId })._id),
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
          },
        },
        { status: 201 },
      ),
      actor,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // Surface a clean message for duplicate-name per user.
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: number }).code === 11000
    ) {
      return NextResponse.json({ error: "A project with that name already exists" }, { status: 409 });
    }
    debugError(1, "[api/projects] POST failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}




