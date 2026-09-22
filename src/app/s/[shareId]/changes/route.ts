/**
 * Route: `/s/:shareId/changes` — recipient-facing history JSON for share pages.
 *
 * Returns a *light* revision history for a shared doc (version + date + summary),
 * gated by doc settings and share password (when enabled).
 *
 * Note: This lives under `/s/:shareId/*` so the existing share auth cookie (often scoped
 * to `/s/:shareId`) is sent by the browser.
 */
import { NextResponse } from "next/server";
import { debugError } from "@/lib/debug";
import { resolveShareLink } from "@/lib/share/links";
import { DocChangeModel } from "@/lib/models/DocChange";
import { shareAuthCookieName, shareAuthCookieValue } from "@/lib/sharePassword";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { ownerCanShowVersionHistory } from "@/lib/share/ownerPlan";
import { Types } from "mongoose";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Cursor = { toVersion: number; createdDate: string; id: string };

/**
 * Parses and clamps the `limit` query param for share history pagination.
 *
 * Exists to keep responses bounded and stable for public share endpoints.
 */
function parseLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return 12;
  return Math.max(1, Math.min(25, Math.floor(n)));
}

/**
 * Decodes a pagination cursor from `base64url(JSON)` (best-effort).
 *
 * Returns null when missing/invalid; callers treat null as "start from newest".
 */
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
    // Parseable as a date, because it goes straight into a Mongo filter as `new Date(...)`. An
    // unparseable string became an Invalid Date, Mongoose's cast asserted, and the catch at the
    // bottom of this route handed the CastError's text to an anonymous recipient — naming the
    // model, the path and the type.
    if (!Number.isFinite(Date.parse(createdDate))) return null;
    return { toVersion: Math.floor(toVersion), createdDate, id };
  } catch {
    return null;
  }
}

/**
 * Encodes a pagination cursor as `base64url(JSON)` for share history pagination.
 *
 * Exists to avoid leaking internal Mongo query details while keeping cursors opaque.
 */
function encodeCursor(c: { toVersion: number; createdDate: string; id: string }): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/**
 * Reads a named cookie value from the request header (minimal parsing).
 *
 * Exists to validate share-password auth cookies without depending on Next.js cookie helpers.
 */
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

/**
 * `GET /s/:shareId/changes`
 *
 * Returns a recipient-facing, paginated revision history for a shared doc.
 * Permissions: requires `shareEnabled` and `shareAllowRevisionHistory`; enforces share password when set.
 * Errors: 400 for invalid input, 401 for missing/invalid share auth cookie, 403 when history is disabled, 404 when not found.
 */
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

      // Revision history is a per-link permission (docs/prds/lnkdrp-multi-links.md).
      const enabled = Boolean(link.allowRevisionHistory);
      if (!enabled) {
        return NextResponse.json({ error: "Version history disabled" }, { status: 403 });
      }

      // ...and a Pro feature. The per-link toggle is gated when it is *set*, which only covers the
      // moment of the write: a workspace that turned it on while on Pro and then downgraded kept
      // serving recipient-facing history forever, because nothing on the read path asked what plan
      // the owner is on today. The owner's own history page is unaffected — it is not plan-gated.
      // A plain 403 rather than `planLimitResponse`: this reply goes to the recipient, who must
      // not be shown the owner's billing state or an upgrade prompt for someone else's workspace.
      if (!(await ownerCanShowVersionHistory(doc as { orgId?: unknown; userId?: unknown }))) {
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

      const mapped = slice.map((c) => {
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

      // `private`, never `public`: a shared cache keyed on the URL alone would keep serving this
      // history for the life of the entry after the link is disabled, expires, or is archived —
      // the three controls whose whole purpose is to stop a recipient reading the document. The
      // short `max-age` still absorbs a recipient's own repeated loads of the history drawer.
      const cacheControl = passwordEnabled ? "no-store" : "private, max-age=30";
      return NextResponse.json(
        { ok: true, changes: mapped, nextCursor },
        { headers: { "cache-control": cacheControl } },
      );
    } catch (err) {
      /**
       * Nothing from the exception reaches the caller.
       *
       * This is a public route: whoever holds the link is anonymous, and every other refusal here
       * is deliberately shapeless so the endpoint cannot be used to learn what exists. Returning
       * `err.message` undid that for any error a crafted request could provoke — a Mongoose
       * CastError spells out the model name, the field and its type.
       */
      debugError(1, "[share/changes] request failed", {
        message: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json({ error: "Bad request" }, { status: 400 });
    }
  });
}


