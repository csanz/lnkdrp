/**
 * API route for `/api/requests`.
 *
 * Lists and creates inbound upload requests and returns a `/request/:token` upload path.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { ProjectModel } from "@/lib/models/Project";
import { debugError, debugLog } from "@/lib/debug";
import { applyTempUserHeaders, resolveActor, tryResolveUserActorFastWithPersonalOrg } from "@/lib/gating/actor";
import { newShareId, newSecretToken } from "@/lib/crypto/randomBase62";

export const runtime = "nodejs";

type Paged<T> = { items: T[]; total: number; page: number; limit: number };
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
  return `${base}-${Date.now().toString(36)}`;
}
/**
 * New Project Share Id.
 */
function newProjectShareId() {
  return newShareId();
}

/**
 * New Request Upload Token.
 */
function newRequestUploadToken() {
  return newSecretToken(32);
}

/**
 * New Request View Token.
 */
function newRequestViewToken() {
  return newSecretToken(32);
}

/**
 * List request repositories (paged).
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    const pageRaw = url.searchParams.get("page");
    const qRaw = url.searchParams.get("q") ?? "";
    const sidebar = url.searchParams.get("sidebar") === "1";
    const limit = Math.max(1, Math.min(50, Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 25));
    const page = Math.max(1, Number.isFinite(Number(pageRaw)) ? Number(pageRaw) : 1);
    const q = qRaw.trim();

    debugLog(2, "[api/requests] GET", { limit, page, sidebar, q: q ? "[redacted]" : "" });
    // Hot path (left menu): avoid heavy resolver; preserve correct personalOrgId for legacy scoping.
    const actor = (sidebar ? await tryResolveUserActorFastWithPersonalOrg(request) : null) ?? (await resolveActor(request));
    await connectMongo();

    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;

    // IMPORTANT: skip backfill/migration work for `sidebar=1` callers (the left sidebar polls frequently).
    if (!sidebar) {
      // Backfill: ensure `isRequest=true` is persisted for any repo that already has a token.
      // This is idempotent and makes the discriminator reliable for downstream UIs/queries.
      await ProjectModel.updateMany(
        {
          ...(allowLegacyByUserId
            ? {
                $or: [
                  { orgId },
                  { userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
                ],
              }
            : { orgId }),
          requestUploadToken: { $exists: true, $nin: [null, ""] },
          $or: [{ isRequest: { $exists: false } }, { isRequest: { $ne: true } }],
        },
        { $set: { isRequest: true } },
      );
    }

    const requestOnly = {
      $or: [{ isRequest: true }, { requestUploadToken: { $exists: true, $nin: [null, ""] } }],
    };
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
        requestOnly,
        ...(q
          ? [
              {
                $or: [
                  { name: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
                  { description: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
                ],
              },
            ]
          : []),
      ],
    };

    const total = await ProjectModel.countDocuments(filter);
    const rows = await ProjectModel.find(filter)
      .select({
        _id: 1,
        name: 1,
        slug: 1,
        description: 1,
        docCount: 1,
        isRequest: 1,
        requestUploadToken: 1,
        requestViewToken: 1,
        updatedDate: 1,
        createdDate: 1,
        orgId: 1,
      })
      .sort({ updatedDate: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    if (!sidebar) {
      // Best-effort backfill: ensure request repos have a view token so owners can share
      // a view-only link without needing a migration.
      const missingViewTokenIds = rows
        .filter((p) => {
          const raw = (p as unknown as { requestViewToken?: unknown }).requestViewToken;
          return !(typeof raw === "string" && raw.trim());
        })
        .map((p) => p._id)
        .filter(Boolean);
      if (missingViewTokenIds.length) {
        await Promise.all(
          missingViewTokenIds.map(async (_id) => {
            try {
              await ProjectModel.updateOne(
                { _id, $or: [{ requestViewToken: { $exists: false } }, { requestViewToken: null }, { requestViewToken: "" }] },
                { $set: { requestViewToken: newRequestViewToken() } },
              );
            } catch {
              // ignore
            }
          }),
        );
      }
    }

    // Best-effort: backfill orgId for legacy personal request repos.
    if (!sidebar && allowLegacyByUserId) {
      const legacyIds = rows
        .filter((p) => !(p as unknown as { orgId?: unknown }).orgId)
        .map((p) => p._id)
        .filter(Boolean);
      if (legacyIds.length) {
        try {
          await ProjectModel.updateMany(
            { _id: { $in: legacyIds }, userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
            { $set: { orgId } },
          );
        } catch {
          // ignore
        }
      }
    }

    const requests: Paged<Record<string, unknown>> = {
      items: rows.map((p) => ({
        id: String(p._id),
        name: (p as { name?: string }).name ?? "",
        slug: (p as { slug?: string }).slug ?? "",
        description: (p as { description?: string }).description ?? "",
        isRequest: true,
        docCount: (function () {
          const raw = (p as unknown as { docCount?: unknown }).docCount;
          return Number.isFinite(raw) ? Number(raw) : 0;
        })(),
        updatedDate: (function () {
          const raw = (p as unknown as { updatedDate?: unknown }).updatedDate;
          return raw ? new Date(String(raw)).toISOString() : null;
        })(),
        createdDate: (function () {
          const raw = (p as unknown as { createdDate?: unknown }).createdDate;
          return raw ? new Date(String(raw)).toISOString() : null;
        })(),
      })),
      total,
      page,
      limit,
    };

    return applyTempUserHeaders(NextResponse.json(requests), actor);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/requests] GET failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/**
 * Create a new "request" (inbound upload folder).
 */
export async function POST(request: Request) {
  try {
    debugLog(1, "[api/requests] POST");
    const actor = await resolveActor(request);
    if (actor.kind !== "user") {
      return applyTempUserHeaders(
        NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 }),
        actor,
      );
    }

    const body = (await request.json().catch(() => ({}))) as Partial<{
      name: string;
      description: string;
      reviewEnabled: boolean;
      reviewPrompt: string;
      requireAuthToUpload: boolean;
    }>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const reviewEnabled = typeof body.reviewEnabled === "boolean" ? body.reviewEnabled : false;
    const reviewPrompt = typeof body.reviewPrompt === "string" ? body.reviewPrompt.trim() : "";
    const requireAuthToUpload =
      typeof body.requireAuthToUpload === "boolean" ? body.requireAuthToUpload : false;
    if (!name) return NextResponse.json({ error: "Request name is required" }, { status: 400 });
    // `reviewPrompt` is optional; when omitted/empty, we run the server-managed default VC review prompts.

    await connectMongo();
    const orgId = new Types.ObjectId(actor.orgId);
    const userId = new Types.ObjectId(actor.userId);
    const base = slugify(name);
    const slug = await ensureUniqueSlug({
      orgId,
      legacyUserId: actor.orgId === actor.personalOrgId ? userId : undefined,
      base,
    });

    // Create with a (secret) token; retry on extremely rare collisions.
    // IMPORTANT: Use a raw Mongo insert so this works even in dev hot-reload scenarios where
    // a stale Mongoose model schema might drop unknown fields like `isRequest` / `requestUploadToken`.
    // We only rely on the created `_id` afterwards (then re-fetch persisted fields for invariants).
    let created: { _id: Types.ObjectId } | null = null;
    let token: string | null = null;
    let viewToken: string | null = null;
    for (let i = 0; i < 5; i++) {
      token = newRequestUploadToken();
      viewToken = newRequestViewToken();
      try {
        const _id = new Types.ObjectId();
        const now = new Date();
        await ProjectModel.collection.insertOne({
          _id,
          orgId,
          userId,
          shareId: newProjectShareId(),
          name,
          slug,
          description,
          docCount: 0,
          autoAddFiles: false,
          isRequest: true,
          requestUploadToken: token,
          requestViewToken: viewToken,
          requestRequireAuthToUpload: requireAuthToUpload,
          requestReviewEnabled: reviewEnabled,
          requestReviewPrompt: reviewPrompt,
          isDeleted: false,
          createdDate: now,
          updatedDate: now,
        });
        created = { _id };
        break;
      } catch (e) {
        // Duplicate token or other unique index collision; retry.
        if (
          e &&
          typeof e === "object" &&
          "code" in e &&
          (e as { code?: number }).code === 11000
        )
          continue;
        throw e;
      }
    }
    if (!created || !token || !viewToken) throw new Error("Failed to create request");
    const p = created;
    // Guardrail: ensure the created project is persisted as a request repo.
    // Backstop: if Mongoose hooks/migrations ever fail to persist `isRequest`, force it here.
    try {
      await ProjectModel.collection.updateOne({ _id: p._id, userId }, { $set: { isRequest: true } });
    } catch {
      // ignore; invariant check below will catch any persistent failure
    }
    const persisted = await ProjectModel.collection.findOne(
      { _id: p._id, userId },
      { projection: { isRequest: 1, requestUploadToken: 1, requestViewToken: 1 } },
    );
    const persistedIsRequest = Boolean(persisted && (persisted as { isRequest?: unknown }).isRequest);
    const persistedTokenRaw = persisted ? (persisted as { requestUploadToken?: unknown }).requestUploadToken : null;
    const persistedToken = typeof persistedTokenRaw === "string" ? persistedTokenRaw.trim() : "";
    const persistedViewTokenRaw = persisted ? (persisted as { requestViewToken?: unknown }).requestViewToken : null;
    const persistedViewToken = typeof persistedViewTokenRaw === "string" ? persistedViewTokenRaw.trim() : "";
    if (!persistedIsRequest) {
      throw new Error("Invariant failed: request repo must be created with isRequest=true");
    }
    if (!persistedToken) {
      throw new Error("Invariant failed: request repo must be created with requestUploadToken");
    }
    if (!persistedViewToken) {
      throw new Error("Invariant failed: request repo must be created with requestViewToken");
    }

    return applyTempUserHeaders(
      NextResponse.json(
        {
          request: {
            projectId: String((p as unknown as { _id: Types.ObjectId })._id),
            name,
            description,
            uploadToken: token,
            uploadPath: `/request/${encodeURIComponent(token)}`,
            viewToken,
            viewPath: `/request-view/${encodeURIComponent(viewToken)}`,
          },
        },
        { status: 201 },
      ),
      actor,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/requests] POST failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


