/**
 * `POST /api/share/:shareId/landing` — a recipient arrived on a project link's page.
 *
 * Public, best-effort, fire-and-forget: it writes the `ProjectLinkView` row that answers "who came
 * through this link, how often, and what did they open" (PRD decision 6). Landings on `/p/:shareId`
 * were recorded nowhere at all before this.
 *
 * It lives beside `stats/` rather than under `/api/projects/**` for three reasons, all of which are
 * about not drifting: it inherits the `/api/share/:shareId/*` cookie scope the unlock route already
 * widened to `path: "/"`; it reaches for the same helper set the view ingest uses — `rateLimit`,
 * `getClientIp`, `tryResolveAuthUserId`, `isOwnerSideViewer`, `after()` — so the owner-preview rule
 * and the identity rule cannot diverge between "landed" and "read" the way the PDF route and the
 * stats route once did; and it is public by construction, unlike `/api/metrics/events`, which
 * refuses to mint an identity for an anonymous caller and therefore cannot serve recipients at all.
 */
import { NextResponse } from "next/server";
import { after } from "next/server";
import { cookies } from "next/headers";
import { Types } from "mongoose";
import crypto from "node:crypto";

import { ProjectLinkViewModel, VISIT_ID_HASH_CAP } from "@/lib/models/ProjectLinkView";
import { UserModel } from "@/lib/models/User";
import { tryResolveAuthUserId } from "@/lib/gating/actor";
import { isOwnerSideViewer } from "@/lib/share/ownerSide";
import { resolveProjectLink } from "@/lib/share/projectLinks";
import { findProjectDocument, projectLinkPasswordEnabled } from "@/lib/share/projectPublic";
import { shareAuthCookieName, shareAuthCookieValue } from "@/lib/sharePassword";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { clientIpFromRequest, rateLimit, rateLimitedResponse } from "@/lib/http/rateLimit";
import { errorJson } from "@/lib/http/errorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A landing is one POST per tab; the budget only has to absorb reloads. */
const LANDING_POST_LIMIT = 60;
const LANDING_POST_WINDOW_MS = 60 * 1000;

/** UTC `YYYY-MM-DD`, the key shape every by-day map in the product uses. */
function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function asNonEmptyString(v: unknown, maxLen = 256): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > maxLen) return null;
  return s;
}

export async function POST(request: Request, ctx: { params: Promise<{ shareId: string }> }) {
  return withMongoRequestLogging(request, async () => {
    try {
      const { shareId } = await ctx.params;
      if (!shareId) return NextResponse.json({ error: "Missing shareId" }, { status: 400 });

      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const botId = asNonEmptyString(body.botId);
      const visitId = asNonEmptyString(body.visitId);
      const docIdRaw = asNonEmptyString(body.docId, 64);
      if (!botId) return NextResponse.json({ error: "Missing botId" }, { status: 400 });

      // Same limiter shape as the stats ingest: proxy-set headers only, so a direct caller cannot
      // rotate buckets by setting `cf-connecting-ip` itself.
      const rl = await rateLimit({
        key: `sharelanding:ip:${clientIpFromRequest(request)}`,
        limit: LANDING_POST_LIMIT,
        windowMs: LANDING_POST_WINDOW_MS,
      });
      if (!rl.ok) return rateLimitedResponse(rl);

      // A refused link records nothing, exactly as a refused document link does.
      const resolved = await resolveProjectLink(shareId);
      if (!resolved || resolved.refusal) return NextResponse.json({ error: "Not found" }, { status: 404 });
      const { link, project } = resolved;

      // A locked link records nothing until the password has actually been given. `/p/[shareId]`
      // renders the beacon only behind this same check (page.tsx), so the guard costs a real
      // recipient nothing — but without it anyone holding the URL of a password-protected data
      // room could POST landings and `$addToSet` documents into `docsOpened`, and those two
      // figures (`totals.landings`, `landedWithoutOpening`) are what the PRD says a sender acts on.
      // Membership-checking the `docId` proves the document is in the project, not that the caller
      // was ever allowed to open it.
      //
      // Answered 200 with no write, never 401: a recipient whose browser refuses the cookie must
      // see a quiet no-op, not an error in the console of a page that is otherwise working.
      if (projectLinkPasswordEnabled(link)) {
        const jar = await cookies();
        const presented = jar.get(shareAuthCookieName(shareId))?.value ?? "";
        const expected = shareAuthCookieValue({ shareId, sharePasswordHash: String(link.passwordHash ?? "") });
        if (!presented || presented !== expected) {
          return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
        }
      }

      const viewerIp = clientIpFromRequest(request) || null;
      const session = await tryResolveAuthUserId(request);
      const viewerUserId = session?.userId && Types.ObjectId.isValid(session.userId) ? new Types.ObjectId(session.userId) : null;
      const botIdHash = crypto.createHash("sha256").update(botId).digest("hex");
      const visitIdHash = visitId ? crypto.createHash("sha256").update(visitId).digest("hex") : null;

      after(async () => {
        try {
          // A `docId` in the body is never trusted: it is re-proved a live member of this link's
          // project before it can join `docsOpened`. The body is the recipient's, the membership
          // is ours.
          const openedDocId = docIdRaw ? (await findProjectDocument(project, docIdRaw, { select: { _id: 1 } }))?._id ?? null : null;

          const ownerPreview = await isOwnerSideViewer(project as { orgId?: unknown; userId?: unknown }, viewerUserId);
          const now = new Date();
          const set: Record<string, unknown> = {
            // `$set`, not `$setOnInsert`: a row written before the default link was materialised
            // would otherwise keep a null join handle forever, and the returning viewer who matches
            // it never gives us another chance to fill it in.
            shareLinkId: link._id,
            lastViewedAt: now,
            isOwnerPreview: ownerPreview,
          };
          if (project.orgId) set.orgId = project.orgId;
          if (viewerIp) set.viewerIp = viewerIp;
          if (viewerUserId) set.viewerUserId = viewerUserId;

          if (viewerUserId) {
            // Denormalize the signed-in viewer's name/email so an owner read is one query.
            try {
              const u = (await UserModel.findById(viewerUserId).select({ name: 1, email: 1 }).lean()) as
                | { name?: string | null; email?: string | null }
                | null;
              if (u?.name && u.name.trim()) set.viewerName = u.name.trim();
              if (u?.email && u.email.trim()) set.viewerEmailSnapshot = u.email.trim().toLowerCase();
            } catch {
              // ignore
            }
          }

          await ProjectLinkViewModel.updateOne(
            { shareId, botIdHash },
            {
              $setOnInsert: { shareId, projectId: project._id, botIdHash, firstViewedAt: now },
              $set: set,
              ...(openedDocId ? { $addToSet: { docsOpened: openedDocId } } : {}),
            },
            { upsert: true },
          ).catch((e: unknown) => {
            // Two first-time landings from one device race and the unique index fails the loser;
            // "the row exists" is not an error worth losing the visit count over.
            const msg = e instanceof Error ? e.message : String(e);
            if (!/E11000|duplicate key/i.test(msg)) throw e;
          });

          // Counted once per tab session, not once per render: a recipient who reloads the list
          // four times looking for a file made one visit. The `$ne` guard and the `$inc` are one
          // atomic update, so two tabs cannot both believe they were first.
          //
          // Two things ride along with `visits`:
          //
          // - `landingsByDay.<day>`, because `visits` is cumulative and the metrics window selects
          //   rows by *last* activity: without a per-day key, a recipient who landed forty times
          //   over six months and came back today put all forty into a three-day window.
          // - `$push` with `$slice`, not `$addToSet`, so the session list is bounded. `$addToSet`
          //   cannot trim, and this route is rate-limited per IP but not per device — a fixed
          //   `botId` could grow one row to the 16MB BSON ceiling, past which every landing write
          //   on that link fails. The `$ne` in the filter still does the deduplication.
          if (visitIdHash) {
            await ProjectLinkViewModel.updateOne(
              { shareId, botIdHash, visitIdHashes: { $ne: visitIdHash } },
              {
                $push: { visitIdHashes: { $each: [visitIdHash], $slice: -VISIT_ID_HASH_CAP } },
                $inc: { visits: 1, [`landingsByDay.${utcDayKey(now)}`]: 1 },
              },
            );
          }
        } catch (e) {
          // Loud on purpose: an empty collection looks exactly like "nobody came".
          console.warn("[api/share/:shareId/landing] landing write failed", e);
        }
      });

      return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    } catch (err) {
      return errorJson(err, { status: 400, publicMessage: "Could not record this visit", context: "[api/share/:shareId/landing] POST failed" });
    }
  });
}
