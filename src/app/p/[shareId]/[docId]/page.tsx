/**
 * Route: `/p/:shareId/:docId` — a document opened from inside a project link.
 *
 * The whole point of this route is the `shareId` it hands the viewer: the **project link's** slug,
 * not the document's own. Every tracking effect in `PdfJsViewer` is keyed on that prop, so the
 * existing `ShareView` / `ShareVisit` machinery — unique viewer, per-page reading time, per-visit
 * sessions, downloads — records against the link the recipient actually received, with no new
 * timing code (PRD decision 5). The stats ingest recovers *which* document from this route's own
 * address; see `POST /api/share/:shareId/stats`.
 *
 * Permissions come from the project link, never from the document: a document that is downloadable
 * on its own link is not downloadable here unless this link says so (PRD decision 3). Revision
 * history is off for every project link — the setting exists per document and a project link has no
 * single document whose versions it could list.
 *
 * `notFound()` covers a slug that is not a project link's, a document that is not in this project,
 * and a project that is gone: a recipient must not be able to probe for document ids by watching
 * the answers change shape. On a password-protected link that probe is refused one step earlier —
 * the gate goes up before the room is asked whether it holds the document at all; see the ordering
 * note in the page body.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import type { AiOutput } from "@/components/PdfJsViewer";
import BrandHeader from "@/components/BrandHeader";
import PasswordGate from "@/components/PasswordGate";
import { workspaceBrandForOrg } from "@/lib/share/shareBrand";
import { shareAuthCookieName, shareAuthCookieValue } from "@/lib/sharePassword";
import { resolveProjectLink } from "@/lib/share/projectLinks";
import { findProjectDocument, projectLinkPasswordEnabled, resolveProjectDocument } from "@/lib/share/projectPublic";
import { buildShareMetadata } from "@/lib/share/shareMetadata";
import ShareViewerClient from "@/app/s/[shareId]/ShareViewerClient";

import RefusalNotice from "../RefusalNotice";

/**
 * Receiver-facing AI payload — the same whitelist `/s/:shareId` applies, for the same reason: the
 * stored `aiOutput` carries evaluative fields written for the sender, and a projection is not a
 * permission.
 */
function pickReceiverAi(aiOutput: unknown): AiOutput | null {
  if (!aiOutput || typeof aiOutput !== "object") return null;
  const ai = aiOutput as Record<string, unknown>;
  const str = (k: string) => (typeof ai[k] === "string" ? (ai[k] as string) : undefined);
  const strArray = (k: string) => (Array.isArray(ai[k]) ? (ai[k] as unknown[]).filter((x): x is string => typeof x === "string") : undefined);
  return {
    one_liner: str("one_liner"),
    core_problem_or_need: str("core_problem_or_need"),
    primary_capabilities_or_scope: strArray("primary_capabilities_or_scope"),
    intended_use_or_context: str("intended_use_or_context"),
    outcomes_or_value: str("outcomes_or_value"),
    maturity_or_status: str("maturity_or_status"),
    summary: str("summary"),
    company_or_project_name: str("company_or_project_name"),
    category: str("category"),
    tags: strArray("tags"),
    key_metrics: strArray("key_metrics"),
    ask: str("ask"),
  };
}

/** Perf: the receiver-facing subset only, never the whole `aiOutput` blob. */
const VIEWER_DOC_FIELDS: Record<string, 1> = {
  title: 1,
  blobUrl: 1,
  "aiOutput.one_liner": 1,
  "aiOutput.core_problem_or_need": 1,
  "aiOutput.primary_capabilities_or_scope": 1,
  "aiOutput.intended_use_or_context": 1,
  "aiOutput.outcomes_or_value": 1,
  "aiOutput.maturity_or_status": 1,
  "aiOutput.summary": 1,
  "aiOutput.company_or_project_name": 1,
  "aiOutput.category": 1,
  "aiOutput.tags": 1,
  "aiOutput.key_metrics": 1,
  "aiOutput.ask": 1,
  receiverRelevanceChecklist: 1,
  previewImageUrl: 1,
  firstPagePngUrl: 1,
};

/**
 * The link card for a data-room document, mirroring `/s/:shareId`'s.
 *
 * Routing a project's documents through `/p/:shareId/:docId` (rather than their own `/s/` links)
 * would otherwise have lost the title and thumbnail a document link has always had, leaving the
 * browser tab reading the root layout's name. Same suppression rule as the document twin, for the
 * same reason a locked `/p/:shareId` shows nothing above the password: a refused or
 * password-protected link gets the generic card, so pasting its URL into a channel unfurls nothing.
 */
export async function generateMetadata(props: { params: Promise<{ shareId: string; docId: string }> }): Promise<Metadata> {
  const { shareId, docId } = await props.params;
  if (!shareId || !docId) return buildShareMetadata({ title: "Shared document", description: "" });

  const resolved = await resolveProjectDocument(shareId, docId, {
    select: { title: 1, previewImageUrl: 1, firstPagePngUrl: 1 } as Record<string, 1>,
    projectSelect: { isRequest: 1 },
  });
  const locked = Boolean(resolved && !resolved.refusal && projectLinkPasswordEnabled(resolved.link));
  const hidden = Boolean(resolved?.project.isRequest);
  const doc = resolved && !resolved.refusal && !locked && !hidden ? (resolved.doc as Record<string, unknown>) : null;
  if (!doc) return buildShareMetadata({ title: "Shared document", description: "" });

  // No preview on a project link's unfurl card, deliberately.
  //
  // This passed `doc.previewImageUrl` — the storage URL, which spells out the document id and
  // upload id — so the card disclosed both to everyone who saw the message the link was pasted
  // into, not only to whoever opened it. `buildShareMetadata` now refuses absolute URLs outright,
  // so passing it would silently fall back to the site image anyway; saying `null` here says so out
  // loud. The document page has a same-origin proxy for this (`/s/:shareId/og.png`). The project
  // link now has a same-origin preview proxy too (`/p/:shareId/:docId/preview`), but it is not an
  // unfurl surface: it answers `401` without the share-auth cookie and an unfurl bot carries none,
  // so a locked room would draw a broken card while an open one would start publishing its first
  // pages into every channel the link is pasted into. Whether a data room unfurls with a picture is
  // a product decision, not a plumbing one; until it is made, the generic mark is the safe side.
  return buildShareMetadata({
    title: (typeof doc.title === "string" ? doc.title : "") || "Shared document",
    description: "",
    previewUrl: null,
  });
}

export default async function ProjectLinkDocumentPage(props: { params: Promise<{ shareId: string; docId: string }> }) {
  const { shareId, docId } = await props.params;
  if (!shareId || !docId) notFound();

  /**
   * The link first, the document only after the password — in that order, and that order is the
   * whole point.
   *
   * This used to resolve link *and* document in one call and 404 when the document was not in the
   * project, which meant the password gate answered two different things: a 200 `PasswordGate` for
   * an id that is in the room, a 404 for one that is not. Walking a list of candidate ids against a
   * locked room therefore returned its exact contents — the document inventory the gate is written
   * to withhold, which is why it renders `title={null} previewUrl={null}` in the first place.
   *
   * So: resolve the link, apply every refusal that depends only on the link, and put the gate up
   * *before* the room is asked whether it contains this document. Behind the gate the answers split
   * again, which is correct — by then the caller has the password.
   *
   * The link-level refusals stay ahead of the gate on purpose: they are properties of the link the
   * recipient already holds, not of its contents, so an expired link still says "expired" rather
   * than asking for a password it will not accept.
   */
  const resolvedLink = await resolveProjectLink(shareId, { select: { isRequest: 1 } });
  if (!resolvedLink) notFound();
  // A request repo has no public room — the rule, and why, is at `/p/[shareId]/page.tsx`. Repeated
  // here because a deep link to one document must not be the way around the room's own 404.
  if (resolvedLink.project.isRequest) notFound();
  const { link } = resolvedLink;
  if (resolvedLink.refusal === "project_gone") notFound();
  // Kept as this page's own check, and no longer normally reached: `../layout.tsx` refuses a
  // refused link above the Suspense boundary so the response is a real 404 instead of this screen
  // under a 200. See the note on the twin in `/p/[shareId]/page.tsx`.
  if (resolvedLink.refusal) return <RefusalNotice kind={resolvedLink.refusal === "expired" ? "expired" : "disabled"} />;

  // Who this is from. Read off the link rather than the project: the link is what the recipient
  // holds, and it is already loaded here.
  const linkOrgId = (link as { orgId?: unknown }).orgId;
  const workspace = await workspaceBrandForOrg(typeof linkOrgId === "undefined" || linkOrgId === null ? null : String(linkOrgId));

  if (projectLinkPasswordEnabled(link)) {
    const c = await cookies();
    const cookie = c.get(shareAuthCookieName(shareId))?.value ?? "";
    const expected = shareAuthCookieValue({ shareId, sharePasswordHash: link.passwordHash as string });
    // One cookie for the whole link: unlocking the project page unlocks every document behind it,
    // and arriving here by deep link with no cookie asks for the password rather than 404ing.
    if (!cookie || cookie !== expected)
      return <PasswordGate shareId={shareId} title={null} previewUrl={null} workspace={workspace} />;
  }

  // Membership is re-proved here, on every request, exactly as `resolveProjectDocument` did — the
  // only change is that it now happens after the gate.
  const doc = await findProjectDocument(resolvedLink.project, docId, { select: VIEWER_DOC_FIELDS });
  if (!doc) notFound();

  const blobUrl = typeof doc.blobUrl === "string" ? doc.blobUrl : "";
  const base = `/p/${encodeURIComponent(shareId)}/${encodeURIComponent(String(doc._id))}`;
  const allowDownload = Boolean(link.allowDownload);

  /**
   * The way back to the room.
   *
   * We already know where this reader came from: they are on `/p/:shareId/:docId`, so they opened
   * this out of a data room, and the room's own page is one level up. Without this the way back is
   * a guess — the viewer takes over the window, and browser-back is not what someone reaches for
   * inside a document that filled the screen.
   *
   * Named, not generic. "Back" tells a reader nothing they did not already know; the room's name is
   * the thing they recognise, and it is the same name they saw on the page they came from. It falls
   * back to the bare arrow only when the project has no name.
   */
  const backHref = `/p/${encodeURIComponent(shareId)}`;
  const projectName = typeof resolvedLink.project.name === "string" ? resolvedLink.project.name.trim() : "";

  if (blobUrl) {
    return (
      <main className="min-h-screen bg-black text-white" style={{ backgroundColor: "#000", color: "#fff" }}>
        <ShareViewerClient
          pdfUrl={`${base}/pdf`}
          // The analytics key: this is the project link, so everything the viewer reports lands
          // under the audience the link was sent to.
          shareId={shareId}
          ai={pickReceiverAi(doc.aiOutput ?? null)}
          relevancyEnabled={Boolean(doc.receiverRelevanceChecklist)}
          allowDownload={allowDownload}
          downloadUrl={allowDownload ? `${base}/pdf?download=1` : null}
          // A project link has no single document whose versions it could list; the toggle does not
          // exist on the model and must not appear here.
          revisionHistoryEnabled={false}
          revisionHistoryUrl={null}
          // The request route cannot resolve a project slug, so the button it would show here
          // opens a modal whose submit always fails. A room with downloads off — which is every
          // room by default — offered exactly that. Hidden until the claim chain can follow a
          // project link.
          canRequestDownload={false}
          workspace={workspace}
          backHref={backHref}
          backLabel={projectName || null}
        />
      </main>
    );
  }

  /**
   * Whether there is a preview, not where it lives.
   *
   * This read the stored value and rendered it as `<img src>`, which is a Vercel Blob URL on a
   * public, unauthenticated CDN: the recipient walked away with a permanent copy of the first page
   * (and with the document and upload ids, which are in the path), and nothing the owner did to the
   * link afterwards could take it back. The bytes come through `/p/:shareId/:docId/preview` now,
   * which re-proves this link's refusals and password before serving anything.
   */
  const hasPreview =
    Boolean(typeof doc.previewImageUrl === "string" ? doc.previewImageUrl.trim() : "") ||
    Boolean(typeof doc.firstPagePngUrl === "string" ? doc.firstPagePngUrl.trim() : "");

  return (
    <main className="min-h-screen bg-black text-white" style={{ backgroundColor: "#000", color: "#fff" }}>
      {/* Same way back as the viewer above: a reader who lands here is just as stuck without it. */}
      <BrandHeader
        workspace={workspace}
        left={
          <a
            href={backHref}
            className="inline-flex h-9 min-w-0 shrink-0 items-center gap-1.5 rounded-2xl border border-white/10 bg-white/5 px-3 text-xs font-medium text-white/80 transition-colors hover:bg-white/10 hover:text-white"
            title={projectName ? `Back to ${projectName}` : "Back"}
          >
            <span aria-hidden="true">&larr;</span>
            <span className="max-w-[160px] truncate">{projectName || "Back"}</span>
          </a>
        }
      />
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <div className="text-lg font-semibold tracking-tight text-white/90">Shared document</div>
        <div className="mt-2 text-sm text-white/70">
          This document is still preparing a PDF viewer. {hasPreview ? "A preview is available below." : "Preview not available yet."}
        </div>
        {hasPreview ? (
          <div className="mt-6 overflow-hidden rounded-2xl border border-white/10 bg-white/5">
            <div className="h-[70svh] w-full bg-black/40">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`${base}/preview`} alt="Document preview" className="h-full w-full object-contain" />
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );
}
