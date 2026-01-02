/**
 * Admin API route: `GET /api/admin/ai-runs`
 *
 * Lists AI run logs (paged) so admins can inspect exact prompts/outputs used by AI features.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { resolveActor } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";
import { UserModel } from "@/lib/models/User";
import { AiRunModel } from "@/lib/models/AiRun";

export const runtime = "nodejs";

function isLocalhostRequest(request: Request) {
  if (process.env.NODE_ENV === "production") return false;
  const host = (request.headers.get("host") ?? "").toLowerCase();
  return host.startsWith("localhost:") || host.startsWith("127.0.0.1:");
}

async function requireAdmin(request: Request) {
  if (isLocalhostRequest(request)) {
    return { ok: true as const, userId: null as string | null };
  }
  const actor = await resolveActor(request);
  if (actor.kind !== "user" || !Types.ObjectId.isValid(actor.userId)) {
    return { ok: false as const, status: 401, error: "Not authenticated" };
  }

  await connectMongo();
  const u = await UserModel.findOne({ _id: new Types.ObjectId(actor.userId) })
    .select({ role: 1 })
    .lean();
  const role = (u as { role?: unknown } | null)?.role;
  if (role !== "admin") return { ok: false as const, status: 403, error: "Forbidden" };

  return { ok: true as const, userId: actor.userId };
}

function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
}

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const url = new URL(request.url);
  const limit = Math.min(asPositiveInt(url.searchParams.get("limit")) ?? 50, 200);
  const page = Math.max(asPositiveInt(url.searchParams.get("page")) ?? 1, 1);
  const kind = (url.searchParams.get("kind") ?? "").trim();
  const status = (url.searchParams.get("status") ?? "").trim();
  const userId = (url.searchParams.get("userId") ?? "").trim();
  const projectId = (url.searchParams.get("projectId") ?? "").trim();
  const docId = (url.searchParams.get("docId") ?? "").trim();
  const uploadId = (url.searchParams.get("uploadId") ?? "").trim();

  await connectMongo();

  const filter: Record<string, unknown> = {};
  if (kind) filter.kind = kind;
  if (status) filter.status = status;
  if (userId && Types.ObjectId.isValid(userId)) filter.userId = new Types.ObjectId(userId);
  if (projectId && Types.ObjectId.isValid(projectId)) {
    filter.$or = [{ projectId: new Types.ObjectId(projectId) }, { projectIds: new Types.ObjectId(projectId) }];
  }
  if (docId && Types.ObjectId.isValid(docId)) filter.docId = new Types.ObjectId(docId);
  if (uploadId && Types.ObjectId.isValid(uploadId)) filter.uploadId = new Types.ObjectId(uploadId);

  const total = await AiRunModel.countDocuments(filter);
  const items = await AiRunModel.find(filter)
    .sort({ createdDate: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .select({
      kind: 1,
      status: 1,
      provider: 1,
      model: 1,
      temperature: 1,
      maxRetries: 1,
      maxTokens: 1,
      durationMs: 1,
      userId: 1,
      projectId: 1,
      projectIds: 1,
      docId: 1,
      uploadId: 1,
      reviewId: 1,
      systemPrompt: 1,
      userPrompt: 1,
      inputTextChars: 1,
      createdDate: 1,
      updatedDate: 1,
    })
    .lean();

  return NextResponse.json({
    ok: true,
    total,
    page,
    limit,
    items: items.map((r) => ({
      id: String(r._id),
      kind: typeof r.kind === "string" ? r.kind : null,
      status: typeof r.status === "string" ? r.status : null,
      provider: typeof (r as { provider?: unknown }).provider === "string" ? (r as { provider: string }).provider : null,
      model: typeof r.model === "string" ? r.model : null,
      temperature: typeof r.temperature === "number" ? r.temperature : null,
      maxRetries: typeof (r as { maxRetries?: unknown }).maxRetries === "number" ? (r as { maxRetries: number }).maxRetries : null,
      maxTokens: typeof (r as { maxTokens?: unknown }).maxTokens === "number" ? (r as { maxTokens: number }).maxTokens : null,
      durationMs: typeof (r as { durationMs?: unknown }).durationMs === "number" ? (r as { durationMs: number }).durationMs : null,
      userId: (r as { userId?: unknown }).userId ? String((r as { userId: unknown }).userId) : null,
      projectId: (r as { projectId?: unknown }).projectId ? String((r as { projectId: unknown }).projectId) : null,
      projectIds: Array.isArray((r as { projectIds?: unknown }).projectIds)
        ? ((r as { projectIds: unknown[] }).projectIds ?? []).map((id) => String(id))
        : [],
      docId: (r as { docId?: unknown }).docId ? String((r as { docId: unknown }).docId) : null,
      uploadId: (r as { uploadId?: unknown }).uploadId ? String((r as { uploadId: unknown }).uploadId) : null,
      reviewId: (r as { reviewId?: unknown }).reviewId ? String((r as { reviewId: unknown }).reviewId) : null,
      systemPromptChars:
        typeof (r as { systemPrompt?: unknown }).systemPrompt === "string"
          ? (r as { systemPrompt: string }).systemPrompt.length
          : 0,
      userPromptChars:
        typeof (r as { userPrompt?: unknown }).userPrompt === "string"
          ? (r as { userPrompt: string }).userPrompt.length
          : 0,
      inputTextChars: typeof (r as { inputTextChars?: unknown }).inputTextChars === "number" ? (r as { inputTextChars: number }).inputTextChars : null,
      updatedDate: r.updatedDate ? new Date(r.updatedDate).toISOString() : null,
      createdDate: r.createdDate ? new Date(r.createdDate).toISOString() : null,
    })),
  });
}


