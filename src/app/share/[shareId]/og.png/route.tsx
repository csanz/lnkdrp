import { notFound } from "next/navigation";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";

/**
 * Legacy route: `/share/:shareId/og.png` → `/s/:shareId/og.png`
 */
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ shareId: string }> },
) {
  const { shareId } = await context.params;
  if (!shareId) notFound();
  redirect(`/s/${encodeURIComponent(shareId)}/og.png`);
}

