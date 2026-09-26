/**
 * Route: `/p/:shareId` — the recipient-facing project page (the data room's front door).
 *
 * This used to be a placeholder that looked up `Project.shareId` directly and linked each card at
 * `/s/<the document's own slug>`, which meant a recipient left the project link the moment they
 * opened anything: the reading, the sessions and the downloads all landed under the document's
 * default link, and the sender could never tell which audience did them. That is the attribution
 * hole docs/prds/lnkdrp-project-links.md exists to close.
 *
 * Now the slug resolves a **project `ShareLink`** (`resolveProjectLink`, which materialises the
 * default link from `Project.shareId` on first visit, so no URL in anyone's inbox stops working),
 * enforces enabled/expiry/password with the same share-auth cookie documents use, and links each
 * card at `/p/:shareId/:docId` so the whole visit stays on one link.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import BrandHeader from "@/components/BrandHeader";
import PasswordGate from "@/components/PasswordGate";
import { workspaceBrandForOrg } from "@/lib/share/shareBrand";
import IntroduceYourself from "../IntroduceYourself";
import { isOwnerSideViewer } from "@/lib/share/ownerSide";
import { serverComponentRequest } from "@/lib/gating/serverComponentRequest";
import { tryResolveAuthUserId } from "@/lib/gating/actor";
import { shareAuthCookieName, shareAuthCookieValue } from "@/lib/sharePassword";
import { shareAuthCookieMatches } from "@/lib/share/cookieCompare";
import { resolveProjectLinkForPage } from "@/lib/share/projectLinks";
import { listProjectDocuments, projectLinkPasswordEnabled, type PublicProjectDoc } from "@/lib/share/projectPublic";
import { buildShareMetadata } from "@/lib/share/shareMetadata";

import LandingBeacon from "../LandingBeacon";
import RefusalNotice from "../RefusalNotice";
import { PROJECT_SHARE_THEME } from "../shareTheme";

function pickDocTitle(doc: PublicProjectDoc): string {
  const title = typeof doc.title === "string" ? doc.title.trim() : "";
  if (title) return title;
  const docName = typeof doc.docName === "string" ? doc.docName.trim() : "";
  if (docName) return docName;
  const fileName = typeof doc.fileName === "string" ? doc.fileName.trim() : "";
  if (fileName) return fileName;
  return "Untitled document";
}

/**
 * Whether this document has a stored first-page image at all — **not** where it is.
 *
 * This used to return the stored value and the card rendered it as `<img src>`. That value is a
 * Vercel Blob URL on a public, unauthenticated CDN, so the room's HTML handed every visitor a
 * permanent copy of the first page of every document in it (with the document and upload ids in the
 * path), which no revoke, expiry or password could take back. The bytes now come through
 * `/p/:shareId/:docId/preview`, which re-proves this link's gate on every request; all this
 * predicate still decides is whether to draw the frame or the "No preview" placeholder.
 */
function docHasPreview(doc: PublicProjectDoc): boolean {
  const a = typeof doc.previewImageUrl === "string" ? doc.previewImageUrl.trim() : "";
  if (a) return true;
  const b = typeof doc.firstPagePngUrl === "string" ? doc.firstPagePngUrl.trim() : "";
  return Boolean(b);
}

type OgLike = { description?: unknown };

function pickDocSummary(aiOutput: unknown): string | null {
  if (!aiOutput || typeof aiOutput !== "object") return null;
  const ai = aiOutput as Record<string, unknown>;
  const oneLiner = typeof ai.one_liner === "string" ? ai.one_liner.trim() : "";
  if (oneLiner) return oneLiner;
  const summary = typeof ai.summary === "string" ? ai.summary.trim() : "";
  if (summary) return summary;
  const metaDesc = typeof ai.meta_description === "string" ? ai.meta_description.trim() : "";
  if (metaDesc) return metaDesc;
  const og = (ai as { openGraph?: OgLike }).openGraph;
  const ogDesc = og && typeof og === "object" && typeof og.description === "string" ? og.description.trim() : "";
  if (ogDesc) return ogDesc;
  return null;
}

function truncate(s: string, max = 220): string {
  const t = s.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/**
 * The data room's own link card: the project's name, and its description when it has one.
 *
 * Locked or refused → the generic card, the same rule `/s/:shareId` follows and the same one the
 * password gate below already applies to the rendered page ("not the project's name, not how many
 * documents are in it"). No document thumbnail ever: a project link points at a list, and the first
 * file in that list is not the thing being shared.
 */
export async function generateMetadata(props: { params: Promise<{ shareId: string }> }): Promise<Metadata> {
  const { shareId } = await props.params;
  if (!shareId) return buildShareMetadata({ title: "Shared documents", description: "" });

  const resolved = await resolveProjectLinkForPage(shareId);
  if (!resolved || resolved.refusal || Boolean(resolved.project.isRequest) || projectLinkPasswordEnabled(resolved.link)) {
    return buildShareMetadata({ title: "Shared documents", description: "" });
  }
  const { project } = resolved;
  const name = typeof project.name === "string" ? project.name.trim() : "";
  const description = typeof project.description === "string" ? project.description.trim() : "";
  return buildShareMetadata({ title: name || "Shared documents", description: description ? truncate(description) : "" });
}

export default async function PublicProjectSharePage(props: { params: Promise<{ shareId: string }> }) {
  const { shareId } = await props.params;
  if (!shareId) notFound();

  // `isRequest` is selected for the rule below; `PROJECT_SHARE_FIELDS` does not carry it, and an
  // unselected field reads as `undefined`, which would pass the check while meaning nothing.
  const resolved = await resolveProjectLinkForPage(shareId);
  // An unknown slug, a document link's slug, or a deleted project: indistinguishable, on purpose.
  if (!resolved || resolved.refusal === "project_gone") notFound();
  /**
   * A request repo has no public room, and this is where that is decided.
   *
   * A data room and a request repo are the same `Project` row pointing opposite ways. A room is
   * documents the owner chose to hand out; a repo is an inbox — `isRequest`, with an upload token
   * the owner sends to outsiders so they can drop files *in*. Those submissions are somebody else's
   * confidential documents (pitch decks, applications, RFP responses) and nobody ever asked for
   * them to be published.
   *
   * They were. A repo is created with a `shareId`, nothing in the resolver filtered on `isRequest`,
   * and a missing `shareEnabled` reads as on everywhere (`shareEnabled !== false`), so the slug
   * rendered as a room listing every submission — no password, no expiry, no sign-in. `GET
   * /api/projects` hands that slug to every member including viewer-role, it never rotates, and the
   * owner could not even switch it off: the project page swaps the share panel out for the
   * request-repo panel when `isRequest`, so the one control that would set `shareEnabled: false` is
   * not rendered for exactly these projects. Hence a rule and not a setting.
   *
   * A 404, indistinguishable from an unknown slug, because who submitted what to whom is not public
   * either. The upload side is untouched: recipients still use `/request/:token`, which is the
   * capability the owner actually sent them.
   */
  if (resolved.project.isRequest) notFound();
  const { link, project } = resolved;
  // Kept, and no longer normally reached: `layout.tsx` now `notFound()`s a refused link so the
  // response carries the 404 this screen was being served under a 200 with. The branch stays as the
  // page's own check — the layout is the status, not the authorization — but a recipient sees the
  // `/p` not-found screen, not these words. (Expiry used to get its own actionable copy here; a 404
  // body cannot know which slug was asked for, so that wording belongs in `/p/not-found.tsx` now.)
  if (resolved.refusal) return <RefusalNotice kind={resolved.refusal === "expired" ? "expired" : "disabled"} />;

  // Who this is from, on every branch below including the gate.
  const workspace = await workspaceBrandForOrg(project.orgId);

  if (projectLinkPasswordEnabled(link)) {
    const c = await cookies();
    const cookie = c.get(shareAuthCookieName(shareId))?.value ?? "";
    const expected = shareAuthCookieValue({ shareId, sharePasswordHash: link.passwordHash as string });
    if (!shareAuthCookieMatches(cookie, expected)) {
      // Nothing before the password — not the project's name, not how many documents are in it.
      // Same rule as the document gate: the sender chose a password because the URL is not the
      // secret, and "Acme — Series A data room · 11 documents" gives away most of the answer.
      return <PasswordGate shareId={shareId} title={null} previewUrl={null} workspace={workspace} />;
    }
  }

  // Resolved per request (PRD open question, "contents follow the project"): a document taken out
  // of the project stops being listed — and stops being openable — on the very next load.
  const docs = await listProjectDocuments(project);
  const name = typeof project.name === "string" ? project.name : "";
  /**
   * The same rule every figure on this link uses: the owner and their teammates are recorded and
   * never counted (`isOwnerSideViewer`), so they are never asked to introduce themselves either.
   *
   * A server component has no `Request` and the session resolver reads the JWT out of one, so one
   * is built here. It has to carry the cookie *jar* and not only the cookie header: `getToken`
   * looks for the session on `req.cookies` and never parses the header, so the hand-built Request
   * this used to pass resolved every owner as a stranger — and the room then asked them to
   * introduce themselves to their own data room. See `serverComponentRequest`.
   */
  const sessionUserId = await (async () => {
    try {
      const session = await tryResolveAuthUserId(await serverComponentRequest("/p"));
      return session?.userId ?? null;
    } catch {
      return null;
    }
  })();
  const ownerSide = await isOwnerSideViewer(project as { orgId?: unknown; userId?: unknown }, sessionUserId);
  const description = typeof project.description === "string" ? project.description : "";

  return (
    <main className="min-h-screen bg-[var(--bg)] text-[var(--fg)]" style={PROJECT_SHARE_THEME}>
      {/* Asking who is here belongs at the top of the room, where the viewer asks it — and never of
          the owning side, who would be introducing themselves to themselves. */}
      <BrandHeader workspace={workspace}>{ownerSide ? null : <IntroduceYourself shareId={shareId} projectName={name} />}</BrandHeader>
      <LandingBeacon shareId={shareId} />
      <div className="mx-auto w-full max-w-5xl px-6 pb-12 pt-6">
        <div className="text-2xl font-semibold tracking-tight text-[var(--fg)]">{name}</div>
        {description ? <div className="mt-2 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">{description}</div> : null}

        <div className="mt-8 flex items-baseline justify-between gap-3">
          <div className="text-sm font-semibold text-[var(--fg)]">Documents</div>
          <div className="text-xs text-[var(--muted-2)]">{docs.length} total</div>
        </div>

        {docs.length ? (
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {docs.map((d) => {
              const docId = String(d._id);
              const title = pickDocTitle(d);
              const hasPreview = docHasPreview(d);
              const summary = pickDocSummary(d.aiOutput ?? null);
              const base = `/p/${encodeURIComponent(shareId)}/${encodeURIComponent(docId)}`;

              return (
                <Link
                  key={docId}
                  // The document opens *under this link*, never at `/s/<its own slug>`: that is what
                  // makes the reading time, the session and any download attributable to the
                  // audience this link was sent to.
                  href={base}
                  className="group overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-sm transition-colors hover:bg-[var(--panel-hover)]"
                  aria-label={`Open shared document: ${title}`}
                >
                  <div className="relative aspect-[16/10] w-full bg-[var(--panel-2)]">
                    {hasPreview ? (
                      // Same origin, never the blob CDN: this path re-runs the link's own checks on
                      // every request, so the thumbnail stops being servable the moment the link
                      // does. See `docHasPreview` above and the route's own header comment.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`${base}/preview`}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-contain transition-transform duration-200 group-hover:scale-[1.01]"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-xs font-medium text-[var(--muted-2)]">
                        No preview
                      </div>
                    )}
                  </div>

                  <div className="px-4 py-4">
                    <div className="text-sm font-semibold leading-snug text-[var(--fg)]">{title}</div>
                    {summary ? (
                      <div className="mt-2 text-sm leading-relaxed text-[var(--muted)]">{truncate(summary)}</div>
                    ) : (
                      <div className="mt-2 text-sm text-[var(--muted-2)]">Open to view details.</div>
                    )}
                    <div className="mt-3 text-xs font-medium text-[var(--muted-2)] group-hover:text-[var(--fg)]">
                      Open shared document →
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        ) : (
          <div className="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
            No documents found in this project.
          </div>
        )}
      </div>
    </main>
  );
}
