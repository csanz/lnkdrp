/**
 * API route for `/api/share/:shareId/changes`.
 *
 * Returns a *light* revision history for a shared doc (version + date + summary),
 * gated by doc settings and share password (when enabled).
 *
 * Plan gate: revision history is a Pro feature of the *owner's* workspace. When the owner is on
 * Free the route answers exactly as if the doc had revision history disabled (`403`), so
 * recipients never see a paywall or any Pro-only data.
 */
import { NextResponse } from "next/server";
import { resolveShareLink } from "@/lib/share/links";
import { DocChangeModel } from "@/lib/models/DocChange";
import { ensurePersonalOrgForUserId } from "@/lib/models/Org";
import { getWorkspacePlan } from "@/lib/billing/planLimits";
import { debugError } from "@/lib/debug";
import { shareAuthCookieName, shareAuthCookieValue } from "@/lib/sharePassword";
import { ownerCanShowVersionHistory } from "@/lib/share/ownerPlan";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { Types } from "mongoose";

export const runtime = "nodejs";

type Cursor = { toVersion: number; createdDate: string; id: string };

function parseLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return 12;
  return Math.max(1, Math.min(25, Math.floor(n)));
}

function decodeCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as any;
    const toVersion = Number.isFinite(parsed?.toVersion) ? Number(parsed.toVersion) : NaN;
    const createdDate = typeof parsed?.createdDate === "string" ? parsed.createdDate : "";
    const id = typeof parsed?.id === "string" ? parsed.id : "";
    if (!Number.isFinite(toVersion) || toVersion < 1) return null;
    if (!createdDate || !id) return null;
    if (!Types.ObjectId.isValid(id)) return null;
    return { toVersion: Math.floor(toVersion), createdDate, id };
  } catch {
    return null;
  }
}

function encodeCursor(c: { toVersion: number; createdDate: string; id: string }): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/**
 * True when the workspace that owns the doc may show recipients its version history.
 *
 * Delegates to the shared read-path gate so this route and `/s/:shareId/changes` cannot answer the
 * same question differently — they did, and the cookie-scoped one was the permissive half.
 */
async function ownerIsPro(doc: { orgId?: unknown; userId?: unknown }): Promise<boolean> {
  const allowed = await ownerCanShowVersionHistory(doc);
  if (!allowed) debugError(1, "[api/share/:shareId/changes] version history withheld (plan)");
  return allowed;
}

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
    try {
      const url = new URL(request.url);
      const limit = parseLimit(url);
      const cursor = decodeCursor(url.searchParams.get("cursor"));

      const { shareId } = await ctx.params;
      if (!shareId) {
        return NextResponse.json({ error: "Missing shareId" }, { status: 400 });
      }

      // Refused links (disabled/expired/archived) answer 404, like an unknown slug.
      const resolved = await resolveShareLink(shareId);
      if (!resolved || resolved.refusal) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      const { link, doc } = resolved;

      // Revision history is a per-link permission. A Free owner (e.g. after a downgrade with the
      // toggle still on) reads as "disabled": the recipient response is identical, so nothing about
      // the owner's plan is exposed.
      const enabled =
        Boolean(link.allowRevisionHistory) && (await ownerIsPro(doc as { orgId?: unknown; userId?: unknown }));
      if (!enabled) {
        return NextResponse.json({ error: "Version history disabled" }, { status: 403 });
      }

      const sharePasswordHash = link.passwordHash;
      const sharePasswordSalt = link.passwordSalt;
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
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
      }

      const docId = (doc as { _id: unknown })._id;
      const cursorFilter = cursor
        ? {
            ...(function () {
              const cursorDate = new Date(cursor.createdDate);
              return {
                $or: [
                  { toVersion: { $lt: cursor.toVersion } },
                  { toVersion: cursor.toVersion, createdDate: { $lt: cursorDate } },
                  { toVersion: cursor.toVersion, createdDate: cursorDate, _id: { $lt: new Types.ObjectId(cursor.id) } },
                ],
              };
            })(),
          }
        : {};

      const changes = await DocChangeModel.find({ docId, ...cursorFilter })
        .sort({ toVersion: -1, createdDate: -1 })
        .limit(limit + 1)
        .select({ _id: 1, fromVersion: 1, toVersion: 1, createdDate: 1, "diff.summary": 1, "diff.pagesThatChanged": 1 })
        .lean();

      const hasMore = changes.length > limit;
      const slice = hasMore ? changes.slice(0, limit) : changes;

      const last = slice.length ? slice[slice.length - 1] : null;
      const nextCursor =
        hasMore && last && typeof (last as any).toVersion === "number" && (last as any).createdDate instanceof Date
          ? encodeCursor({
              toVersion: Math.floor((last as any).toVersion),
              createdDate: (last as any).createdDate.toISOString(),
              id: String((last as any)._id),
            })
          : null;

      const out = slice.map((c) => {
        const createdDate = (c as any).createdDate instanceof Date ? (c as any).createdDate.toISOString() : null;
        const summary = typeof (c as any).diff?.summary === "string" ? (c as any).diff.summary.trim() : "";
        const pagesThatChangedRaw = (c as any).diff?.pagesThatChanged;
        const pagesThatChanged = Array.isArray(pagesThatChangedRaw)
          ? pagesThatChangedRaw
              /**
               * Text only, and deliberately so.
               *
               * The owner's view also gets `previousImageUrl` and `newImageUrl` and draws the two
               * pages side by side. Those are public blob URLs that outlive the link being
               * disabled, expired or archived, so handing them to a recipient widens exactly the
               * leak the blob work exists to close - that surface waits for the proxy.
               *
               * None of this does. What changed, in which direction, and what each marked area of
               * the page was about are sentences, and they are most of what a recipient opening
               * "what changed" actually wants.
               */
              .map((p: any) => ({
                pageNumber: typeof p?.pageNumber === "number" && Number.isFinite(p.pageNumber) ? Math.floor(p.pageNumber) : null,
                summary: typeof p?.summary === "string" ? p.summary : "",
                changeKind:
                  p?.changeKind === "added" || p?.changeKind === "removed" || p?.changeKind === "replaced" ? p.changeKind : null,
                previousWording: typeof p?.previousWording === "string" && p.previousWording.trim() ? p.previousWording : null,
                newWording: typeof p?.newWording === "string" && p.newWording.trim() ? p.newWording : null,
                regionNotes: Array.isArray(p?.regionNotes)
                  ? p.regionNotes.filter((n: unknown) => typeof n === "string" && n.trim()).slice(0, 3)
                  : [],
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

      return NextResponse.json({ ok: true, changes: out, nextCursor }, { headers: { "cache-control": "no-store" } });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  });
}


