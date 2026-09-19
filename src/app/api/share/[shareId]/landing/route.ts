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
import { recordActivity } from "@/lib/activity/log";
import { propagateViewerIdentity, viewerIdentityNews } from "@/lib/share/viewerIdentity";
import { normalizeShareViewerEmail, normalizeShareViewerName } from "@/lib/share/viewerProfile";
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
      // "Introduce yourself", answered on the room's front page. The same two fields the document
      // ingest takes, through the same normalizers, so one person cannot end up stored two ways
      // depending on which page they typed into.
      const introName = normalizeShareViewerName(asNonEmptyString(body.viewerName, 160) ?? "");
      const introEmail = normalizeShareViewerEmail(asNonEmptyString(body.viewerEmail, 320) ?? "");
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
          // Asked before the write, while the old identity is still on the row.
          const news =
            !viewerUserId && (introName || introEmail)
              ? await viewerIdentityNews({
                  shareId,
                  botIdHash,
                  orgId: project.orgId ? String(project.orgId) : null,
                  name: introName,
                  email: introEmail,
                })
              : { isNew: false, changed: false };
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

          // Anonymous only, exactly as on the document ingest: a signed-in visitor's identity comes
          // from their account below and a typed-in name must never overwrite it.
          if (!viewerUserId && introName) set.viewerName = introName;
          if (!viewerUserId && introEmail) set.viewerEmailSnapshot = introEmail;

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

          /**
           * Whether this is the first time this person has been on the room's front page.
           *
           * Not `upsertedCount`: the stats ingest upserts the *same* `(shareId, botIdHash)` row
           * when a recipient deep-links straight to `/p/:slug/:docId` — deliberately, so a reader
           * who never passes through the front page is still counted. That made the row already
           * exist for exactly the cohort a data room is usually sent to, and no arrival was ever
           * announced for them. `landedAt` is the landing route's own sentinel, so the two writers
           * stop competing for one flag.
           */
          let firstLanding = false;
          await ProjectLinkViewModel.updateOne(
            { shareId, botIdHash },
            {
              $setOnInsert: { shareId, projectId: project._id, botIdHash, firstViewedAt: now },
              $set: set,
              ...(openedDocId ? { $addToSet: { docsOpened: openedDocId } } : {}),
            },
            { upsert: true },
          )
            .then(async () => {
              // Claim the sentinel: whoever sets it is the first landing, whether or not this
              // write created the row.
              try {
                const claim = await ProjectLinkViewModel.updateOne(
                  { shareId, botIdHash, landedAt: { $exists: false } },
                  { $set: { landedAt: now } },
                );
                firstLanding = Boolean((claim as { modifiedCount?: number } | null)?.modifiedCount);
              } catch {
                // An arrival that cannot be marked is not announced twice; it is not announced.
              }
            })
            .catch((e: unknown) => {
              // Two first-time landings from one device race and the unique index fails the loser;
              // "the row exists" is not an error worth losing the visit count over.
              const msg = e instanceof Error ? e.message : String(e);
              if (!/E11000|duplicate key/i.test(msg)) throw e;
            });

          /**
           * Say in the feed that someone arrived.
           *
           * A data room's whole point is that a recipient can open it and read nothing, and that
           * reader wrote no `ShareView` row — so before this, the one visitor a sender most wanted
           * to know about was the one the feed could not mention. The rules are the document
           * ingest's, deliberately, so "arrived" and "read" cannot drift:
           *
           * - `!ownerPreview`: the owning side checking its own link is recorded and never
           *   announced (`isOwnerSideViewer`);
           * - `firstLanding`: once per recipient, not once per reload — the same bound
           *   `share.viewed` uses, and the reason a feed of arrivals stays readable.
           */
          // A visitor who introduces themselves here has usually read something already — in this
          // room or another of this workspace's links — so the answer is written through to those
          // rows too, and the owner sees one person rather than one name and several strangers.
          // Same gate as the event below, and for the same reason: see the stats ingest.
          if ((news.isNew || news.changed) && !viewerUserId && (introName || introEmail)) {
            try {
              await propagateViewerIdentity({
                shareId,
                botIdHash,
                orgId: project.orgId ? String(project.orgId) : null,
                name: introName,
                email: introEmail,
              });
            } catch {
              // best-effort: the arrival row above already carries the new identity.
            }
          }

          /**
           * Someone put a name to their visit. This is the event a sender most wants pushed at
           * them — an anonymous number on a chart just became a person they can reply to — and
           * unlike every other recipient event it stays visible on Free: the name was volunteered
           * *to* this workspace, so withholding it would be withholding a message meant for them.
           */
          if ((news.isNew || news.changed) && !ownerPreview && project.orgId) {
            void recordActivity({
              orgId: String(project.orgId),
              userId: viewerUserId ? String(viewerUserId) : null,
              actorKind: "viewer",
              type: "viewer.introduced",
              projectId: String(project._id),
              title: typeof project.name === "string" ? project.name : null,
              meta: {
                changed: news.changed,
                viewerName: introName,
                viewerEmail: introEmail,
                shareId,
                linkLabel: link.label ?? null,
                isDefaultLink: Boolean(link.isDefault),
                projectName: typeof project.name === "string" ? project.name : null,
              },
              request,
            });
          }

          if (firstLanding && !ownerPreview && project.orgId) {
            void recordActivity({
              orgId: String(project.orgId),
              userId: viewerUserId ? String(viewerUserId) : null,
              actorKind: "viewer",
              type: "project.landed",
              projectId: String(project._id),
              title: typeof project.name === "string" ? project.name : null,
              meta: {
                authenticated: Boolean(viewerUserId),
                // Same key the document feed uses, so a name given later renames this row too
                // (see the `viewerKey` join in src/app/api/activity/route.ts).
                viewerKey: botIdHash,
                viewerName: typeof set.viewerName === "string" ? set.viewerName : null,
                viewerEmail: typeof set.viewerEmailSnapshot === "string" ? set.viewerEmailSnapshot : null,
                shareId,
                linkLabel: link.label ?? null,
                isDefaultLink: Boolean(link.isDefault),
                projectName: typeof project.name === "string" ? project.name : null,
              },
              request,
            });
          }

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
