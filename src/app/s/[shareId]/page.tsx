/**
 * Route: `/s/:shareId` — recipient-facing public share page (optionally password gated).
 */
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { resolveShareLink } from "@/lib/share/links";
import type { AiOutput } from "@/components/PdfJsViewer";
import ShareViewerClient from "./ShareViewerClient";
import BrandHeader from "@/components/BrandHeader";
import PasswordGate from "./PasswordGate";
import { shareAuthCookieName, shareAuthCookieValue } from "@/lib/sharePassword";
import { buildShareMetadata } from "@/lib/share/shareMetadata";
import { workspaceBrandForOrg } from "@/lib/share/shareBrand";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type OgLike = {
  title?: unknown;
  description?: unknown;
  imageUrl?: unknown;
  imagePath?: unknown;
};

/**
 * Narrow AI output into the specific OG strings we use for metadata.
 */
function pickOgStrings(aiOutput: unknown): { title?: string; description?: string } {
  if (!aiOutput || typeof aiOutput !== "object") return {};
  const og = (aiOutput as { openGraph?: OgLike }).openGraph;
  if (!og || typeof og !== "object") return {};
  const title = typeof og.title === "string" ? og.title : undefined;
  const description = typeof og.description === "string" ? og.description : undefined;
  return { title, description };
}

function pickMetaStrings(aiOutput: unknown): { title?: string; description?: string } {
  if (!aiOutput || typeof aiOutput !== "object") return {};
  const ai = aiOutput as Record<string, unknown>;
  const title = typeof ai.meta_title === "string" ? ai.meta_title : undefined;
  const description = typeof ai.meta_description === "string" ? ai.meta_description : undefined;
  return { title, description };
}

/**
 * Receiver-facing AI payload: keep it high-signal and non-evaluative.
 * (Also avoids leaking fields we don't want to display.)
 */
function pickReceiverAi(aiOutput: unknown): AiOutput | null {
  if (!aiOutput || typeof aiOutput !== "object") return null;
  const ai = aiOutput as Record<string, unknown>;
  return {
    one_liner: typeof ai.one_liner === "string" ? ai.one_liner : undefined,
    core_problem_or_need:
      typeof ai.core_problem_or_need === "string" ? ai.core_problem_or_need : undefined,
    primary_capabilities_or_scope: Array.isArray(ai.primary_capabilities_or_scope)
      ? ai.primary_capabilities_or_scope.filter((x): x is string => typeof x === "string")
      : undefined,
    intended_use_or_context:
      typeof ai.intended_use_or_context === "string" ? ai.intended_use_or_context : undefined,
    outcomes_or_value: typeof ai.outcomes_or_value === "string" ? ai.outcomes_or_value : undefined,
    maturity_or_status:
      typeof ai.maturity_or_status === "string" ? ai.maturity_or_status : undefined,
    summary: typeof ai.summary === "string" ? ai.summary : undefined,
    company_or_project_name:
      typeof ai.company_or_project_name === "string" ? ai.company_or_project_name : undefined,
    category: typeof ai.category === "string" ? ai.category : undefined,
    tags: Array.isArray(ai.tags) ? ai.tags.filter((x): x is string => typeof x === "string") : undefined,
    key_metrics: Array.isArray(ai.key_metrics)
      ? ai.key_metrics.filter((x): x is string => typeof x === "string")
      : undefined,
    ask: typeof ai.ask === "string" ? ai.ask : undefined,
  };
}

/**
 * Dynamic metadata for a public share page.
 *
 * Uses request headers to compute an absolute OG image URL.
 */
export async function generateMetadata(props: {
  params: Promise<{ shareId: string }>;
}): Promise<Metadata> {
  const { shareId } = await props.params;
  if (!shareId) return { title: "Shared document" };

  // One link → one document (docs/prds/lnkdrp-multi-links.md). A refused link keeps the generic
  // title so a disabled/expired link never leaks the document's name into a link preview.
  const resolved = await resolveShareLink(shareId, {
    select: {
      title: 1,
      // Perf: only pull the minimal metadata-related AI fields (avoid huge aiOutput JSON).
      "aiOutput.meta_title": 1,
      "aiOutput.meta_description": 1,
      "aiOutput.openGraph.title": 1,
      "aiOutput.openGraph.description": 1,
      previewImageUrl: 1,
      firstPagePngUrl: 1,
    } as Record<string, 1>,
  });
  // A password-protected link gets the same generic card as a refused one. Otherwise pasting the
  // URL into Slack unfurled the deck's real title and its first page to the whole channel, which is
  // the leak the password exists to prevent — and the unfurl happens before anyone types anything.
  const linkIsLocked = Boolean(resolved && !resolved.refusal && resolved.link.passwordHash && resolved.link.passwordSalt);
  const doc =
    resolved && !resolved.refusal && !linkIsLocked
      ? (resolved.doc as {
          title?: unknown;
          aiOutput?: unknown;
          previewImageUrl?: unknown;
          firstPagePngUrl?: unknown;
        })
      : null;

  const meta = pickMetaStrings(doc?.aiOutput);
  const og = pickOgStrings(doc?.aiOutput);
  const title =
    meta.title || og.title || (typeof doc?.title === "string" ? doc.title : "") || "Shared document";
  const description = meta.description || og.description || "Shared with LinkDrop.";

  // The preview goes out through our own proxy, never as the blob's own URL.
  //
  // This used to publish `doc.previewImageUrl` verbatim, which is the storage URL and carries the
  // document id and upload id in its path — so the unfurl card in every Slack channel and mailbox a
  // link was forwarded to disclosed both, to anyone who saw the message rather than only to whoever
  // opened the link. `/s/:shareId/og.png` re-serves the same bytes from this origin and applies the
  // same refusal and password gates the page does, so a revoked link stops unfurling too.
  return buildShareMetadata({ title, description, previewUrl: `/s/${shareId}/og.png` });
}

/**
 * Public recipient view for `/s/:shareId`.
 *
 * Renders the PDF in a client-side viewer when available, otherwise shows a
 * "preparing" fallback with an image preview (if present).
 */
export default async function SharePage(props: {
  params: Promise<{ shareId: string }>;
}) {
  const { shareId } = await props.params;
  if (!shareId) notFound();

  // The link is the unit of sharing: it carries the password, the download and revision-history
  // permissions, and whether the page may be served at all (docs/prds/lnkdrp-multi-links.md).
  const resolved = await resolveShareLink(shareId, {
    select: {
      title: 1,
      blobUrl: 1,
      // The workspace behind the link, so the header can say who shared this.
      orgId: 1,
      // Perf: only fetch receiver-facing AI snapshot fields (avoid huge aiOutput JSON).
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
    } as Record<string, 1>,
  });
  // Disabled, expired, archived or deleted: the link behaves as if it never existed.
  if (!resolved || resolved.refusal) notFound();
  const { link, doc } = resolved;

  // Who this is from. Read once, used on every branch below — the gate included, which is the one
  // page a recipient sees that says nothing else about what they are being shown.
  const docOrgId = (doc as { orgId?: unknown }).orgId;
  const workspace = await workspaceBrandForOrg(typeof docOrgId === "undefined" || docOrgId === null ? null : String(docOrgId));

  /**
   * Whether there is a preview, not where it lives.
   *
   * This used to be the stored value, rendered as `<img src>` — a Vercel Blob URL on a public,
   * unauthenticated CDN. The recipient walked away with a permanent copy of the first page, and
   * with the document and upload ids, which are in the path; every other artifact the pipeline
   * writes hangs off that same prefix, `extracted.txt` included. Nothing the owner did to the link
   * afterwards could take any of it back.
   *
   * The bytes come through `/s/:shareId/preview` now, which re-proves this link's refusals and its
   * password before serving anything. The same change was made on the data-room side first.
   */
  const hasPreview =
    Boolean(typeof doc.previewImageUrl === "string" ? doc.previewImageUrl.trim() : "") ||
    Boolean(typeof doc.firstPagePngUrl === "string" ? doc.firstPagePngUrl.trim() : "");
  const previewUrl = hasPreview ? `/s/${encodeURIComponent(shareId)}/preview` : null;

  const sharePasswordHash = link.passwordHash;
  const sharePasswordSalt = link.passwordSalt;
  const passwordEnabled =
    typeof sharePasswordHash === "string" &&
    Boolean(sharePasswordHash) &&
    typeof sharePasswordSalt === "string" &&
    Boolean(sharePasswordSalt);

  if (passwordEnabled) {
    const c = await cookies();
    const cookie = c.get(shareAuthCookieName(shareId))?.value ?? "";
    const expected = shareAuthCookieValue({
      shareId,
      sharePasswordHash: sharePasswordHash as string,
    });
    if (!cookie || cookie !== expected) {
      // Nothing about the document before the password: not its name, and certainly not the
      // rendered first page, which is the document. A gate that shows a deck's title and its cover
      // slide to anyone holding the URL has already given away most of what the password was set
      // to protect — and the sender chose a password precisely because the URL is not the secret.
      return <PasswordGate shareId={shareId} title={null} previewUrl={null} workspace={workspace} />;
    }
  }

  const pdfUrl = doc.blobUrl ? `/s/${encodeURIComponent(shareId)}/pdf` : null;
  const ai = pickReceiverAi(doc.aiOutput ?? null);
  // Permissions belong to the link, not the document: two recipients of the same deck can have
  // different download rights.
  const allowDownload = Boolean(link.allowDownload);
  const allowRevisionHistory = Boolean(link.allowRevisionHistory);

  if (pdfUrl) {
    return (
      <main className="min-h-screen bg-black text-white" style={{ backgroundColor: "#000", color: "#fff" }}>
        <ShareViewerClient
          pdfUrl={pdfUrl}
          shareId={shareId}
          ai={ai}
          relevancyEnabled={Boolean(doc.receiverRelevanceChecklist)}
          allowDownload={allowDownload}
          downloadUrl={allowDownload ? `/s/${encodeURIComponent(shareId)}/pdf?download=1` : null}
          revisionHistoryEnabled={allowRevisionHistory}
          revisionHistoryUrl={allowRevisionHistory ? `/s/${encodeURIComponent(shareId)}/changes` : null}
          workspace={workspace}
        />
      </main>
    );
  }

  // Fallback if we don't have a PDF URL yet (older docs / processing).
  return (
    <main className="min-h-screen bg-black text-white" style={{ backgroundColor: "#000", color: "#fff" }}>
      <BrandHeader workspace={workspace} />
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <div className="text-lg font-semibold tracking-tight text-white/90">Shared document</div>
        <div className="mt-2 text-sm text-white/70">
          This document is still preparing a PDF viewer.{" "}
          {previewUrl ? "A preview is available below." : "Preview not available yet."}
        </div>

        {previewUrl ? (
          <div className="mt-6 overflow-hidden rounded-2xl border border-white/10 bg-white/5">
            <div className="h-[70svh] w-full bg-black/40">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={previewUrl}
                alt="Document preview"
                className="h-full w-full object-contain"
              />
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );
}
