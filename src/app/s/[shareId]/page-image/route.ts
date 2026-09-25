/**
 * Route: `/s/:shareId/page-image` - one rendered page of one version, for a recipient.
 *
 * The owner's comparison shows both renders of a changed page side by side. The recipient's did
 * not, and the reason was never that recipients should not see the pages - they are reading the
 * document - it was that the renders live at public blob URLs. Handing one to a recipient hands
 * them an address that keeps working after the link is disabled, expires, is archived or the
 * document is deleted, which is the whole point of those controls.
 *
 * So the bytes come through here instead. Every request re-checks the link the same way the
 * history JSON does - resolvable, revision history allowed, the owner still on a plan that permits
 * it, and the share password satisfied - and revoking the link stops the images with it. The blob
 * URL never reaches the browser.
 *
 * Lives under `/s/:shareId/*` so the share auth cookie, which is scoped to that path, is sent.
 */
import { NextResponse } from "next/server";

import { debugError } from "@/lib/debug";
import { resolveShareLink } from "@/lib/share/links";
import { UploadModel } from "@/lib/models/Upload";
import { shareAuthCookieName, shareAuthCookieValue } from "@/lib/sharePassword";
import { shareAuthCookieMatches } from "@/lib/share/cookieCompare";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { fetchStoredBlob } from "@/lib/blob/fetchStoredBlob";
import { ownerCanShowVersionHistory } from "@/lib/share/ownerPlan";
import { MAX_PREVIEW_BYTES, pinnedImageMime } from "@/lib/share/pinnedImageMime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Minimal cookie read, matching the sibling history route. */
function getCookie(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=") || "";
  }
  return null;
}

function intParam(url: URL, key: string): number | null {
  const n = Number(url.searchParams.get(key));
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
}

/**
 * `GET /s/:shareId/page-image?v=<version>&p=<page>&size=thumb|full`
 *
 * Errors: 400 on bad input, 401 when the share password cookie is missing or wrong, 403 when
 * version history is off for this link or this owner's plan, 404 for everything else - an unknown
 * slug, a refused link, a version that is not there. All of them answer the same way on purpose,
 * so this cannot be used to probe which versions a document has.
 */
export async function GET(request: Request, ctx: { params: Promise<{ shareId: string }> }) {
  return withMongoRequestLogging(request, async () => {
    try {
      const url = new URL(request.url);
      const { shareId } = await ctx.params;
      if (!shareId) return NextResponse.json({ error: "Missing shareId" }, { status: 400 });

      const version = intParam(url, "v");
      const pageNumber = intParam(url, "p");
      if (!version || !pageNumber) return NextResponse.json({ error: "Missing version or page" }, { status: 400 });

      const resolved = await resolveShareLink(shareId);
      if (!resolved || resolved.refusal) return NextResponse.json({ error: "Not found" }, { status: 404 });
      const { link, doc } = resolved;

      if (!link.allowRevisionHistory) return NextResponse.json({ error: "Version history disabled" }, { status: 403 });
      if (!(await ownerCanShowVersionHistory(doc as { orgId?: unknown; userId?: unknown }))) {
        return NextResponse.json({ error: "Version history disabled" }, { status: 403 });
      }

      const sharePasswordHash = link.passwordHash;
      const sharePasswordSalt = link.passwordSalt;
      const passwordEnabled =
        typeof sharePasswordHash === "string" && Boolean(sharePasswordHash) && typeof sharePasswordSalt === "string" && Boolean(sharePasswordSalt);
      if (passwordEnabled) {
        const cookie = getCookie(request, shareAuthCookieName(shareId)) ?? "";
        const expected = shareAuthCookieValue({ shareId, sharePasswordHash: sharePasswordHash as string });
        if (!shareAuthCookieMatches(cookie, expected)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      const upload = (await UploadModel.findOne({
        docId: (doc as { _id: unknown })._id,
        version,
        isDeleted: { $ne: true },
        status: "completed",
      })
        .select({ slideNodes: 1 })
        .lean()) as { slideNodes?: unknown } | null;

      const nodes = Array.isArray(upload?.slideNodes) ? (upload?.slideNodes as Array<Record<string, unknown>>) : [];
      const node = nodes.find((n) => Math.floor(Number(n?.pageNumber ?? n?.page_number)) === pageNumber);
      // The thumbnail by default: the recipient's panel shows these small, and a deck's worth of
      // full renders is ten times the bytes for detail nothing is displaying.
      const wantFull = url.searchParams.get("size") === "full";
      const pick = (key: string) => (typeof node?.[key] === "string" && (node[key] as string).trim() ? (node[key] as string) : null);
      const target = wantFull ? pick("imageUrl") ?? pick("thumbUrl") : pick("thumbUrl") ?? pick("imageUrl");
      if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });

      /**
       * Through `fetchStoredBlob`, not a bare fetch.
       *
       * This dereferences a URL read out of the database and streams whatever comes back to an
       * anonymous link holder - the exact shape that helper exists to contain. It checks the host
       * against the blob store allowlist and refuses to follow a redirect off it; a bare `fetch`
       * does neither, and follows redirects by default. Not exploitable today, because only the
       * processing job writes `slideNodes` - but that is an invariant this codebase has already
       * been bitten by once, and it would regress silently the moment any other write path touches
       * those rows.
       */
      const upstream = await fetchStoredBlob(target);
      if (!upstream || !upstream.ok || !upstream.body) return NextResponse.json({ error: "Not found" }, { status: 404 });

      // The type is decided by the bytes, never echoed from the store (`pinnedImageMime`): this
      // route copied the upstream header while its two sibling image routes sniffed, and an
      // upstream answering `text/html` would have made this origin serve markup.
      const declaredLength = Number(upstream.headers.get("content-length") ?? "");
      if (Number.isFinite(declaredLength) && declaredLength > MAX_PREVIEW_BYTES) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (bytes.length > MAX_PREVIEW_BYTES) return NextResponse.json({ error: "Not found" }, { status: 404 });
      const mime = pinnedImageMime(bytes);
      if (!mime) return NextResponse.json({ error: "Not found" }, { status: 404 });

      return new NextResponse(bytes, {
        status: 200,
        headers: {
          "content-type": mime,
          "content-length": String(bytes.length),
          // `private`, and short. A shared cache keyed on the URL alone would go on serving these
          // after the link is disabled, which is the thing this route exists to prevent; the small
          // max-age still absorbs a recipient scrolling their own history panel.
          "cache-control": "private, max-age=60",
          "x-content-type-options": "nosniff",
        },
      });
    } catch (err) {
      debugError(1, "[s/page-image] failed", { message: err instanceof Error ? err.message : String(err) });
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  });
}
