/**
 * Admin API route: `GET /api/admin/ai-runs/:runId`
 *
 * Returns a single AI run log record: its parameters, its timing and its error — never its prompts
 * or its output. Those are the customer's document (see `src/lib/admin/docPrivacy.ts`), and this
 * route used to serve them in full for any run in any workspace, one tab away from the pages that
 * display the "contents are not available in admin" banner.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { AiRunModel } from "@/lib/models/AiRun";
import { requireAdmin } from "@/lib/gating/requireAdmin";
import { AI_RUN_CONTENT_FIELDS, describeAiRunContent } from "@/lib/admin/docPrivacy";
import { aiRunSpend } from "@/lib/admin/aiRunSpend";

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

  // Size the prompts and the output, then delete them off the in-memory row. The response below is
  // built field by field and never touches them, but a `...r` added to it one day would, and there
  // would be nothing left on the row to leak. `error` stays: a failure's message is diagnostics.
  const raw = r as unknown as Record<string, unknown>;
  const content = describeAiRunContent(raw);
  for (const f of AI_RUN_CONTENT_FIELDS) delete raw[f];

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
      inputTextChars: typeof (r as { inputTextChars?: unknown }).inputTextChars === "number" ? (r as { inputTextChars: number }).inputTextChars : null,
      // What was sent and what came back, as shape only: whether each part exists and how long it
      // was. That answers the questions the page is for — did it run, did the model return empty,
      // was the prompt truncated — without reproducing the customer's document.
      content,
      // What the run spent, summed over every provider call it made. `modelRoute` can differ from
      // `model` above: the summary and the compare pick their model by modality, so a page-image
      // run goes to the dearer one whatever tier was paid for.
      ...aiRunSpend(raw),
      error: (r as { error?: unknown }).error ?? null,
      updatedDate: r.updatedDate ? new Date(r.updatedDate).toISOString() : null,
      createdDate: r.createdDate ? new Date(r.createdDate).toISOString() : null,
    },
  });
}


