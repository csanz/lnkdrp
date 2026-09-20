/**
 * Admin API route: `GET /api/admin/data/projects`
 *
 * Lists projects across all users (paged).
 *
 * The public slug and `requestUploadToken` are selected to say whether they exist and then dropped:
 * one opens `/p/:shareId`, the other submits documents into the customer's repo, and neither needs
 * to be readable to answer an operational question. Both still work as search terms above.
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

  const filter: Record<string, unknown> = {};
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ name: rx }, { slug: rx }, { shareId: rx }, { requestUploadToken: rx }];
  }

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
    projects: items.map((p) => ({
      id: String(p._id),
      userId: p.userId ? String(p.userId) : null,
      name: typeof p.name === "string" ? p.name : null,
      slug: typeof p.slug === "string" ? p.slug : null,
      description: typeof p.description === "string" ? p.description : null,
      docCount: Number.isFinite(p.docCount) ? p.docCount : null,
      isRequest: Boolean((p as { isRequest?: unknown }).isRequest),
      // Whether the project has a public slug and an upload token, not what they are. The page
      // reads `hasRequestUploadToken` where it used to read the token, to spot a repo whose
      // `isRequest` was never backfilled.
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




