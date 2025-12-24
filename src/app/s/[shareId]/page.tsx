import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { PdfJsViewer, type AiOutput } from "@/components/PdfJsViewer";
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
  const t =
    typeof (aiOutput as { meta_title?: unknown }).meta_title === "string"
      ? ((aiOutput as { meta_title: string }).meta_title ?? undefined)
      : undefined;
  const d =
    typeof (aiOutput as { meta_description?: unknown }).meta_description === "string"
      ? ((aiOutput as { meta_description: string }).meta_description ?? undefined)
      : undefined;
  return { title: t, description: d };
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
  const doc = await DocModel.findOne({ shareId, isDeleted: { $ne: true } }).lean();

  const meta = pickMetaStrings(doc?.aiOutput);
  const og = pickOgStrings(doc?.aiOutput);
  const title = meta.title || og.title || doc?.title || "Shared document";
  const description = meta.description || og.description || "Shared with LinkDrop.";

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? "https";
  const metadataBase = new URL(`${proto}://${host}`);

  const ogImageUrl = new URL(`/s/${shareId}/og.png`, metadataBase);

  return {
    title,
    description,
    metadataBase,
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [{ url: ogImageUrl }],
    },
    openGraph: {
      type: "website",
      title,
      description,
      images: [{ url: ogImageUrl }],
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
  const doc = await DocModel.findOne({ shareId, isDeleted: { $ne: true } }).lean();
  if (!doc) notFound();

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
      return <PasswordGate shareId={shareId} title={typeof doc.title === "string" ? doc.title : null} />;
    }
  }

  const pdfUrl = doc.blobUrl ? `/s/${encodeURIComponent(shareId)}/pdf` : null;
  const previewUrl = doc.previewImageUrl ?? doc.firstPagePngUrl ?? null;
  const ai = pickReceiverAi(doc.aiOutput ?? null);
  const allowDownload = Boolean((doc as { shareAllowPdfDownload?: unknown }).shareAllowPdfDownload);

  if (pdfUrl) {
    // PdfJsViewer is a client component; pass the AI output as JSON (or null).
    return (
      <PdfJsViewer
        url={pdfUrl}
        initialPage={1}
        shareId={shareId}
        ai={ai}
        relevancyEnabled={Boolean(doc.receiverRelevanceChecklist)}
        allowDownload={allowDownload}
        downloadUrl={allowDownload ? `/s/${encodeURIComponent(shareId)}/pdf?download=1` : null}
      />
    );
  }

  // Fallback if we don't have a PDF URL yet (older docs / processing).
  return (
    <main className="min-h-screen bg-white text-zinc-900">
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <div className="text-lg font-semibold tracking-tight">Shared document</div>
        <div className="mt-2 text-sm text-zinc-600">
          This document is still preparing a PDF viewer.{" "}
          {previewUrl ? "A preview is available below." : "Preview not available yet."}
        </div>

        {previewUrl ? (
          <div className="mt-6 overflow-hidden rounded-2xl border border-zinc-200 bg-white">
            <div className="h-[70svh] w-full bg-zinc-50">
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


