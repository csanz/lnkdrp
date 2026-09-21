/**
 * Admin API route: `GET /api/admin/emails/previews`
 *
 * Renders every email template that has a pure builder, by calling that builder with the sample
 * inputs listed alongside each result. Nothing here reads the database and nothing is sent.
 *
 * The fixtures and the rendering live in `@/lib/email/previews`, shared with
 * `scripts/send-test-emails.ts` so the bodies an operator previews are the bodies that get posted
 * to a real inbox.
 */
import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/gating/requireAdmin";
import { EMAIL_CATALOG } from "@/lib/email/templates";
import { buildPreviews, type PreviewRow } from "@/lib/email/previews";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const previews = buildPreviews();
  const covered = new Set(previews.map((p) => p.catalogId));
  // Catalog rows with no preview, each with the reason, so the page never implies the list is
  // complete: four of them are built inline inside the notification job and one inside its sender.
  const unavailable = EMAIL_CATALOG.filter((row) => !covered.has(row.id)).map((row) => ({
    catalogId: row.id,
    what: row.what,
    builtBy: row.builtBy,
  }));

  return NextResponse.json({ ok: true, previews, unavailable });
}
