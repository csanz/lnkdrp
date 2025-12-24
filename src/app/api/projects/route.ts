import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { ProjectModel } from "@/lib/models/Project";
import { debugError, debugLog } from "@/lib/debug";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";

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

async function ensureUniqueSlug(opts: { userId: Types.ObjectId; base: string }) {
  const base = opts.base || "project";
  // Try base, then base-2, base-3, ...
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const exists = await ProjectModel.exists({ userId: opts.userId, slug: candidate });
    if (!exists) return candidate;
  }
  // Last resort: include timestamp suffix.
  return `${base}-${Date.now().toString(36)}`;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    const pageRaw = url.searchParams.get("page");
    const qRaw = url.searchParams.get("q") ?? "";
    const limit = Math.max(
      1,
      Math.min(50, Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 25),
    );
    const page = Math.max(1, Number.isFinite(Number(pageRaw)) ? Number(pageRaw) : 1);
    const q = qRaw.trim();

    debugLog(2, "[api/projects] GET", { limit, page, q: q ? "[redacted]" : "" });
    const actor = await resolveActor(request);
    await connectMongo();

    const filter: Record<string, unknown> = { userId: new Types.ObjectId(actor.userId) };
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ name: rx }, { description: rx }];
    }

    const total = await ProjectModel.countDocuments(filter);
    const projects = await ProjectModel.find(filter)
      .sort({ updatedDate: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // Best-effort: backfill slug for older projects.
    for (const p of projects) {
      const s = (p as unknown as { slug?: unknown }).slug;
      if (typeof s === "string" && s.trim()) continue;
      const base = slugify((p as unknown as { name?: unknown }).name ? String((p as { name?: unknown }).name) : "");
      const slug = await ensureUniqueSlug({ userId: new Types.ObjectId(actor.userId), base });
      await ProjectModel.updateOne(
        {
          _id: p._id,
          userId: new Types.ObjectId(actor.userId),
          $or: [{ slug: { $exists: false } }, { slug: null }, { slug: "" }],
        },
        { $set: { slug } },
      );
      (p as unknown as { slug?: string }).slug = slug;
    }

    return applyTempUserHeaders(
      NextResponse.json({
        total,
        page,
        limit,
        projects: projects.map((p) => ({
          id: String(p._id),
          name: p.name ?? "",
          slug: (p as unknown as { slug?: string }).slug ?? "",
          description: p.description ?? "",
          autoAddFiles: Boolean((p as unknown as { autoAddFiles?: unknown }).autoAddFiles),
          updatedDate: p.updatedDate ? new Date(p.updatedDate).toISOString() : null,
          createdDate: p.createdDate ? new Date(p.createdDate).toISOString() : null,
        })),
      }),
      actor,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/projects] GET failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

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
    const userId = new Types.ObjectId(actor.userId);
    const base = slugify(name);
    const slug = await ensureUniqueSlug({ userId, base });
    const created = await ProjectModel.create({
      userId,
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
            name,
            slug,
            description,
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



