/**
 * API route for `/api/share/:shareId/changes`.
 *
 * Returns a *light* revision history for a shared doc (version + date + summary),
 * gated by doc settings and share password (when enabled).
 */
import { NextResponse } from "next/server";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { DocChangeModel } from "@/lib/models/DocChange";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { shareAuthCookieName, shareAuthCookieValue } from "@/lib/sharePassword";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";

export const runtime = "nodejs";

function getCookie(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) return null;
  // Minimal cookie parsing (no decoding needed for our values).
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=") || "";
  }
  return null;
}

export async function GET(request: Request, ctx: { params: Promise<{ shareId: string }> }) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActor(request);
    try {
      const { shareId } = await ctx.params;
      if (!shareId) {
        return applyTempUserHeaders(NextResponse.json({ error: "Missing shareId" }, { status: 400 }), actor);
      }

      await connectMongo();
      const doc = await DocModel.findOne({ shareId, isDeleted: { $ne: true } })
        .select({
          _id: 1,
          shareAllowRevisionHistory: 1,
          sharePasswordHash: 1,
          sharePasswordSalt: 1,
        })
        .lean();
      if (!doc) {
        return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
      }

      const enabled = Boolean((doc as { shareAllowRevisionHistory?: unknown }).shareAllowRevisionHistory);
      if (!enabled) {
        return applyTempUserHeaders(
          NextResponse.json({ error: "Revision history disabled" }, { status: 403 }),
          actor,
        );
      }

      const sharePasswordHash = (doc as { sharePasswordHash?: unknown }).sharePasswordHash;
      const sharePasswordSalt = (doc as { sharePasswordSalt?: unknown }).sharePasswordSalt;
      const passwordEnabled =
        typeof sharePasswordHash === "string" &&
        Boolean(sharePasswordHash) &&
        typeof sharePasswordSalt === "string" &&
        Boolean(sharePasswordSalt);
      if (passwordEnabled) {
        const cookieName = shareAuthCookieName(shareId);
        const cookie = getCookie(request, cookieName) ?? "";
        const expected = shareAuthCookieValue({ shareId, sharePasswordHash: sharePasswordHash as string });
        if (!cookie || cookie !== expected) {
          return applyTempUserHeaders(NextResponse.json({ error: "Unauthorized" }, { status: 401 }), actor);
        }
      }

      const docId = (doc as { _id: unknown })._id;
      const changes = await DocChangeModel.find({ docId })
        .sort({ toVersion: -1, createdDate: -1 })
        .limit(50)
        .select({ _id: 0, fromVersion: 1, toVersion: 1, createdDate: 1, "diff.summary": 1, "diff.pagesThatChanged": 1 })
        .lean();

      const out = changes.map((c) => {
        const createdDate = (c as any).createdDate instanceof Date ? (c as any).createdDate.toISOString() : null;
        const summary = typeof (c as any).diff?.summary === "string" ? (c as any).diff.summary.trim() : "";
        const pagesThatChangedRaw = (c as any).diff?.pagesThatChanged;
        const pagesThatChanged = Array.isArray(pagesThatChangedRaw)
          ? pagesThatChangedRaw
              .map((p: any) => ({
                pageNumber: typeof p?.pageNumber === "number" && Number.isFinite(p.pageNumber) ? Math.floor(p.pageNumber) : null,
                summary: typeof p?.summary === "string" ? p.summary : "",
              }))
              .filter((p: any) => typeof p.pageNumber === "number" && p.pageNumber >= 1)
          : [];
        return {
          fromVersion: Number.isFinite((c as any).fromVersion) ? Number((c as any).fromVersion) : null,
          toVersion: Number.isFinite((c as any).toVersion) ? Number((c as any).toVersion) : null,
          createdDate,
          summary,
          pagesThatChanged,
        };
      });

      return applyTempUserHeaders(NextResponse.json({ ok: true, changes: out }), actor);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return applyTempUserHeaders(NextResponse.json({ error: message }, { status: 400 }), actor);
    }
  });
}


