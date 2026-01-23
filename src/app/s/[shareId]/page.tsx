/**
 * Route: `/s/:shareId` — recipient-facing public share page (optionally password gated).
 */
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import type { AiOutput } from "@/components/PdfJsViewer";
import ShareViewerClient from "./ShareViewerClient";
import PasswordGate from "./PasswordGate";
import { shareAuthCookieName, shareAuthCookieValue } from "@/lib/sharePassword";

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

  await connectMongo();
  const doc = await DocModel.findOne({ shareId, isDeleted: { $ne: true } })
    .select({
      title: 1,
      // Perf: only pull the minimal metadata-related AI fields (avoid huge aiOutput JSON).
      "aiOutput.meta_title": 1,
      "aiOutput.meta_description": 1,
      "aiOutput.openGraph.title": 1,
      "aiOutput.openGraph.description": 1,
      previewImageUrl: 1,
      firstPagePngUrl: 1,
    })
    .lean();

  const meta = pickMetaStrings(doc?.aiOutput);
  const og = pickOgStrings(doc?.aiOutput);
  const title = meta.title || og.title || doc?.title || "Shared document";
  const description = meta.description || og.description || "Shared with LinkDrop.";

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? "https";
  const metadataBase = new URL(`${proto}://${host}`);

  // Prefer the doc preview thumbnail (if it's a real URL). Fall back to the site default OG image.
  const previewCandidate =
    (typeof (doc as { previewImageUrl?: unknown })?.previewImageUrl === "string" &&
      (doc as { previewImageUrl: string }).previewImageUrl) ||
    (typeof (doc as { firstPagePngUrl?: unknown })?.firstPagePngUrl === "string" &&
      (doc as { firstPagePngUrl: string }).firstPagePngUrl) ||
    null;

  const ogImageMeta: NonNullable<Metadata["openGraph"]>["images"] = (() => {
    if (typeof previewCandidate === "string" && previewCandidate) {
      if (/^https?:\/\//i.test(previewCandidate)) {
        return [{ url: new URL(previewCandidate), alt: title }];
      }
      if (previewCandidate.startsWith("/")) {
        return [{ url: new URL(previewCandidate, metadataBase), alt: title }];
      }
    }
    return [
      {
        url: new URL("/images/og.png", metadataBase),
        width: 840,
        height: 491,
        alt: title,
      },
    ];
  })();

  return {
    title,
    description,
    metadataBase,
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ogImageMeta,
    },
    openGraph: {
      type: "website",
      title,
      description,
      images: ogImageMeta,
    },
  };
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

  await connectMongo();
  const doc = await DocModel.findOne({ shareId, isDeleted: { $ne: true } })
    .select({
      title: 1,
      blobUrl: 1,
      shareEnabled: 1,
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
      shareAllowPdfDownload: 1,
      shareAllowRevisionHistory: 1,
      sharePasswordHash: 1,
      sharePasswordSalt: 1,
      previewImageUrl: 1,
      firstPagePngUrl: 1,
    })
    .lean();
  if (!doc) notFound();
  // Master share switch: when disabled, behave like the share link is gone.
  if ((doc as { shareEnabled?: unknown }).shareEnabled === false) notFound();

  const previewUrl = doc.previewImageUrl ?? doc.firstPagePngUrl ?? null;

  const sharePasswordHash = (doc as { sharePasswordHash?: unknown }).sharePasswordHash;
  const sharePasswordSalt = (doc as { sharePasswordSalt?: unknown }).sharePasswordSalt;
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
      return (
        <PasswordGate
          shareId={shareId}
          title={typeof doc.title === "string" ? doc.title : null}
          previewUrl={typeof previewUrl === "string" ? previewUrl : null}
        />
      );
    }
  }

  const pdfUrl = doc.blobUrl ? `/s/${encodeURIComponent(shareId)}/pdf` : null;
  const ai = pickReceiverAi(doc.aiOutput ?? null);
  const allowDownload = Boolean((doc as { shareAllowPdfDownload?: unknown }).shareAllowPdfDownload);
  const allowRevisionHistory = Boolean((doc as { shareAllowRevisionHistory?: unknown }).shareAllowRevisionHistory);

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
        />
      </main>
    );
  }

  // Fallback if we don't have a PDF URL yet (older docs / processing).
  return (
    <main className="min-h-screen bg-black text-white" style={{ backgroundColor: "#000", color: "#fff" }}>
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
