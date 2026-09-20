/**
 * Admin API route: `GET /api/admin/data/docs`
 *
 * Lists docs across all users (paged) for admin inspection.
 */
import { NextResponse } from "next/server";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { requireAdmin } from "@/lib/gating/requireAdmin";

export const runtime = "nodejs";


/**
 * Parses a value into a positive integer (>= 1) or returns null.
 *
 * Used to safely accept query params while keeping pagination logic predictable.
 * Never throws; returns null on NaN/Infinity/non-positive values.
 */
function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
}

/**
 * Escapes a string for safe use inside a RegExp literal.
 *
 * Exists to support user-provided search terms without regex injection.
 */
function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The `$or` behind `?q=`: substring over the title, whole-value equality over the share slug.
 *
 * The route already refuses to *select* `shareId` (see the projection below) — and then the filter
 * gave it back a character at a time. An unanchored `new RegExp(q, "i")` over a field the caller
 * cannot read is an extraction oracle: find a row with a two-character `q`, extend the substring by
 * one character and keep whichever of the 62 candidates keeps that row's `id` in the response.
 * `newShareId()` is `randomBase62(12)`, so ~12 x 62 unthrottled requests recover a slug, and
 * `/s/<shareId>` then renders the document. Matching the slug whole keeps the lookup the comment
 * below describes — paste a slug the customer gave you — and returns nothing the caller did not
 * already know. Case-sensitive: base62 slugs are, and a folded match would find a different doc.
 *
 * Written as `{ $eq: q }` rather than a bare `q`: the operator says *match this value*, and the
 * source scan in `tests/lib/adminRouteSecrets.test.ts` reads these four files for that shape.
 */
function searchClauses(q: string): Record<string, unknown>[] {
  return [{ title: new RegExp(escapeRegex(q), "i") }, { shareId: { $eq: q } }];
}

/**
 * `GET /api/admin/data/docs`
 *
 * Returns a paginated list of non-deleted docs for admin inspection, optionally filtered
 * by search query, status, and archived flag. Requires admin role (except localhost in dev).
 * Errors: returns 400 for invalid query params, 401/403 for auth/permission failures.
 */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const url = new URL(request.url);
  const limit = Math.min(asPositiveInt(url.searchParams.get("limit")) ?? 50, 200);
  const page = Math.max(asPositiveInt(url.searchParams.get("page")) ?? 1, 1);
  const qRaw = url.searchParams.get("q") ?? "";
  const q = qRaw.trim();
  const statusRaw = (url.searchParams.get("status") ?? "").trim(); // draft|preparing|ready|failed|""
  const archivedRaw = (url.searchParams.get("archived") ?? "").trim(); // "yes"|"no"|""
  const sortRaw = (url.searchParams.get("sort") ?? "").trim(); // updatedDate|createdDate
  const orderRaw = (url.searchParams.get("order") ?? "").trim().toLowerCase(); // asc|desc

  await connectMongo();

  const filter: Record<string, unknown> = {
    isDeleted: { $ne: true },
  };
  if (q) {
    filter.$or = searchClauses(q);
  }
  if (statusRaw) {
    const allowed = new Set(["draft", "preparing", "ready", "failed"]);
    if (!allowed.has(statusRaw)) {
      return NextResponse.json({ error: "status must be one of: draft | preparing | ready | failed" }, { status: 400 });
    }
    filter.status = statusRaw;
  }
  if (archivedRaw) {
    if (archivedRaw !== "yes" && archivedRaw !== "no") {
      return NextResponse.json({ error: "archived must be one of: yes | no" }, { status: 400 });
    }
    filter.isArchived = archivedRaw === "yes";
  }

  const sortField = sortRaw === "createdDate" ? "createdDate" : "updatedDate";
  const sortDir = orderRaw === "asc" ? 1 : -1;

  const total = await DocModel.countDocuments(filter);
  const items = await DocModel.find(filter)
    .sort({ [sortField]: sortDir, _id: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .select({
      userId: 1,
      title: 1,
      status: 1,
      // `shareId` is searched above but never selected: `/s/:shareId` renders the document, so a
      // slug in a listing is the whole document redaction was built to withhold. Matching a slug
      // the customer supplied — whole, see `searchClauses` — is a lookup; handing 200 of them back
      // is a key ring, and so was matching them a character at a time.
      shareEnabled: 1,
      isArchived: 1,
      createdDate: 1,
      updatedDate: 1,
    })
    .lean();

  return NextResponse.json({
    ok: true,
    total,
    page,
    limit,
    status: statusRaw || null,
    archived: archivedRaw || null,
    sort: sortField,
    order: sortDir === 1 ? "asc" : "desc",
    docs: items.map((d) => ({
      id: String(d._id),
      userId: d.userId ? String(d.userId) : null,
      title: typeof d.title === "string" ? d.title : null,
      status: typeof d.status === "string" ? d.status : null,
      shareEnabled: (d as { shareEnabled?: unknown }).shareEnabled !== false,
      isArchived: Boolean((d as { isArchived?: unknown }).isArchived),
      updatedDate: d.updatedDate ? new Date(d.updatedDate).toISOString() : null,
      createdDate: d.createdDate ? new Date(d.createdDate).toISOString() : null,
    })),
  });
}




