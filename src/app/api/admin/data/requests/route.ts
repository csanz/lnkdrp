/**
 * Admin API route: `GET /api/admin/data/requests`
 *
 * Lists request link repos (stored as Projects with request fields) across all users (paged).
 *
 * The two tokens that make a repo work — `requestUploadToken` (submit documents into it) and its
 * public slug — are selected to answer "is this repo live?" and then dropped. They used to come
 * back in every row, and the page turned the upload token into a clickable `/request/:token`, so
 * the listing was a set of working write capabilities into other people's workspaces. Either token
 * still works as a search term: matching one an admin was handed *whole* is a lookup, not a handout
 * — matching a fragment of one was a handout in instalments; see `searchClauses`.
 */
import { NextResponse } from "next/server";
import { connectMongo } from "@/lib/mongodb";
import { ProjectModel } from "@/lib/models/Project";
import { requireAdmin } from "@/lib/gating/requireAdmin";
import { stripSecrets } from "@/lib/admin/docPrivacy";

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
 * The `$or` behind `?q=`: substring over the names the rows already show, whole-value equality over
 * the two fields whose *value is the access*. Same clause, same reasoning, as the projects listing.
 *
 * `shareId` and `requestUploadToken` are stripped from every row below and then were handed back by
 * the filter a character at a time: with an unanchored `new RegExp(q, "i")`, a caller picks a row
 * with a two-character `q`, extends the substring by one character and keeps whichever of the 62
 * candidates keeps that row's `id` in the response. Both tokens are base62 (12 and 24 characters),
 * so ~12 x 62 and ~24 x 62 unthrottled requests recover them — and the upload token is the worse of
 * the two, because `POST /api/requests/:token/uploads` mints a fresh `uploadSecret`, a session-less
 * write into a customer's repo with no expiry and no revocation.
 *
 * Equality keeps the lookup this header promises and returns nothing new: a whole-value match only
 * confirms a token the caller already held. Case-sensitive, because base62 is.
 *
 * Written as `{ $eq: q }` rather than a bare `q`: the operator says *match this value*, and the
 * source scan in `tests/lib/adminRouteSecrets.test.ts` reads these four files for that shape.
 */
function searchClauses(q: string): Record<string, unknown>[] {
  const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  return [{ name: rx }, { slug: rx }, { shareId: { $eq: q } }, { requestUploadToken: { $eq: q } }];
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

  await connectMongo();

  // Backfill: ensure `isRequest=true` is persisted for any repo that already has a token.
  // Admin views should reflect the canonical discriminator to avoid confusion.
  await ProjectModel.updateMany(
    {
      requestUploadToken: { $exists: true, $nin: [null, ""] },
      $or: [{ isRequest: { $exists: false } }, { isRequest: { $ne: true } }],
    },
    { $set: { isRequest: true } },
  );

  // Request repos are stored as Projects with request-only fields (e.g. requestUploadToken).
  const isRequestRepo: Record<string, unknown> = {
    $or: [{ isRequest: true }, { requestUploadToken: { $exists: true, $ne: null } }],
  };

  // Two fragments, each with its own `$or`, so they go under `$and` rather than being merged — a
  // bare merge drops one. Built as a fresh object because the previous shape pushed `filter` into
  // its own `$and` and then deleted the `$or` it had just captured: `$and[0]` ended up pointing at
  // the filter itself (a cyclic document the driver cannot serialise) with the discriminator gone,
  // so a search neither narrowed to request repos nor, in fact, ran.
  const filter: Record<string, unknown> = q
    ? { $and: [isRequestRepo, { $or: searchClauses(q) }] }
    : isRequestRepo;

  const total = await ProjectModel.countDocuments(filter);
  const items = await ProjectModel.find(filter)
    .sort({ updatedDate: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .select({
      userId: 1,
      name: 1,
      slug: 1,
      description: 1,
      shareId: 1,
      docCount: 1,
      createdDate: 1,
      updatedDate: 1,
      // request-only fields (not necessarily in schema; ok for Mongo select)
      isRequest: 1,
      requestUploadToken: 1,
      requestReviewEnabled: 1,
    })
    .lean();

  return NextResponse.json({
    ok: true,
    total,
    page,
    limit,
    requests: items.map((p) => ({
      id: String(p._id),
      userId: p.userId ? String(p.userId) : null,
      name: typeof p.name === "string" ? p.name : null,
      slug: typeof p.slug === "string" ? p.slug : null,
      description: typeof p.description === "string" ? p.description : null,
      docCount: Number.isFinite(p.docCount) ? p.docCount : null,
      isRequest: Boolean((p as { isRequest?: unknown }).isRequest),
      // Whether the repo has a public slug and an upload token, not what they are.
      secrets: stripSecrets(p as unknown as Record<string, unknown>).secrets,
      requestReviewEnabled: Boolean((p as { requestReviewEnabled?: unknown }).requestReviewEnabled),
      updatedDate: (p as unknown as { updatedDate?: Date | string | null }).updatedDate
        ? new Date((p as unknown as { updatedDate: Date | string }).updatedDate).toISOString()
        : null,
      createdDate: (p as unknown as { createdDate?: Date | string | null }).createdDate
        ? new Date((p as unknown as { createdDate: Date | string }).createdDate).toISOString()
        : null,
    })),
  });
}


