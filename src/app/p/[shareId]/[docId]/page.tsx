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
 * the answers change shape.
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
import { projectLinkPasswordEnabled, resolveProjectDocument } from "@/lib/share/projectPublic";
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

  const preview =
    (typeof doc.previewImageUrl === "string" && doc.previewImageUrl) ||
    (typeof doc.firstPagePngUrl === "string" && doc.firstPagePngUrl) ||
    null;
  return buildShareMetadata({
    title: (typeof doc.title === "string" ? doc.title : "") || "Shared document",
    description: "",
    previewUrl: preview,
  });
}

export default async function ProjectLinkDocumentPage(props: { params: Promise<{ shareId: string; docId: string }> }) {
  const { shareId, docId } = await props.params;
  if (!shareId || !docId) notFound();

  const resolved = await resolveProjectDocument(shareId, docId, { select: VIEWER_DOC_FIELDS, projectSelect: { isRequest: 1 } });
  if (!resolved) notFound();
  // A request repo has no public room — the rule, and why, is at `/p/[shareId]/page.tsx`. Repeated
  // here because a deep link to one document must not be the way around the room's own 404.
  if (resolved.project.isRequest) notFound();
  const { link, doc } = resolved;
  if (resolved.refusal === "project_gone") notFound();
  if (resolved.refusal) return <RefusalNotice kind={resolved.refusal === "expired" ? "expired" : "disabled"} />;

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

  const blobUrl = typeof doc.blobUrl === "string" ? doc.blobUrl : "";
  const base = `/p/${encodeURIComponent(shareId)}/${encodeURIComponent(String(doc._id))}`;
  const allowDownload = Boolean(link.allowDownload);

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
          workspace={workspace}
        />
      </main>
    );
  }

  const previewUrl =
    typeof doc.previewImageUrl === "string" ? doc.previewImageUrl : typeof doc.firstPagePngUrl === "string" ? doc.firstPagePngUrl : null;

  return (
    <main className="min-h-screen bg-black text-white" style={{ backgroundColor: "#000", color: "#fff" }}>
      <BrandHeader workspace={workspace} />
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <div className="text-lg font-semibold tracking-tight text-white/90">Shared document</div>
        <div className="mt-2 text-sm text-white/70">
          This document is still preparing a PDF viewer. {previewUrl ? "A preview is available below." : "Preview not available yet."}
        </div>
        {previewUrl ? (
          <div className="mt-6 overflow-hidden rounded-2xl border border-white/10 bg-white/5">
            <div className="h-[70svh] w-full bg-black/40">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previewUrl} alt="Document preview" className="h-full w-full object-contain" />
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );
}
