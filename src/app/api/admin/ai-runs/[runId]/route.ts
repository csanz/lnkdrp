/**
 * Admin API route: `GET /api/admin/ai-runs/:runId`
 *
 * Returns a single AI run log record including full prompt/output payloads.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { AiRunModel } from "@/lib/models/AiRun";
import { requireAdmin } from "@/lib/gating/requireAdmin";

export const runtime = "nodejs";



/**
 *
 */
export async function GET(request: Request, ctx: { params: Promise<{ runId: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { runId } = await ctx.params;
  if (!Types.ObjectId.isValid(runId)) {
    return NextResponse.json({ error: "Invalid runId" }, { status: 400 });
  }

  await connectMongo();
  const r = await AiRunModel.findById(new Types.ObjectId(runId)).lean();
  if (!r) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    ok: true,
    run: {
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
      systemPrompt: typeof (r as { systemPrompt?: unknown }).systemPrompt === "string" ? (r as { systemPrompt: string }).systemPrompt : null,
      userPrompt: typeof (r as { userPrompt?: unknown }).userPrompt === "string" ? (r as { userPrompt: string }).userPrompt : null,
      inputTextChars: typeof (r as { inputTextChars?: unknown }).inputTextChars === "number" ? (r as { inputTextChars: number }).inputTextChars : null,
      outputText: typeof (r as { outputText?: unknown }).outputText === "string" ? (r as { outputText: string }).outputText : null,
      outputObject: (r as { outputObject?: unknown }).outputObject ?? null,
      error: (r as { error?: unknown }).error ?? null,
      updatedDate: r.updatedDate ? new Date(r.updatedDate).toISOString() : null,
      createdDate: r.createdDate ? new Date(r.createdDate).toISOString() : null,
    },
  });
}


