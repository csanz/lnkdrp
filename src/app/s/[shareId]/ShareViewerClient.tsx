"use client";

/**
 * Share viewer wrapper (client component).
 *
 * Route: `/s/:shareId`
 * Purpose: Render the heavy PDF viewer client-side (no SSR) while showing a fast loading shell.
 */
import dynamic from "next/dynamic";
import type { AiOutput } from "@/components/PdfJsViewer";

const PdfJsViewer = dynamic(async () => (await import("@/components/PdfJsViewer")).PdfJsViewer, {
  ssr: false,
  loading: () => (
    <div
      className="group relative flex h-[100svh] w-screen flex-col overflow-hidden bg-black text-white"
      style={{ backgroundColor: "#000", color: "#fff" }}
    >
      {/* Header placeholder (prevents layout shift when PdfJsViewer loads) */}
      <header className="sticky top-0 z-20 w-full border-b border-white/10 bg-black/85 text-white/90 backdrop-blur-sm">
        <div className="px-4 py-3 sm:px-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <div aria-hidden="true" className="h-[26px] w-[26px] rounded-md bg-white/10" />
              <div className="h-8 w-36 rounded-2xl border border-white/10 bg-white/5" />
            </div>
            <div className="h-8 w-28 rounded-2xl border border-white/10 bg-white/5" />
          </div>
        </div>
      </header>

      <div className="grid flex-1 place-items-center px-6">
        <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-black/70 px-4 py-3 text-sm text-white/90 shadow-xl backdrop-blur-sm">
          <div
            className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white/90"
            aria-hidden="true"
          />
          <div className="font-medium">Loading…</div>
        </div>
      </div>
    </div>
  ),
});

export default function ShareViewerClient(props: {
  pdfUrl: string;
  shareId: string;
  ai: AiOutput | null;
  relevancyEnabled: boolean;
  allowDownload: boolean;
  downloadUrl: string | null;
  revisionHistoryEnabled: boolean;
  revisionHistoryUrl: string | null;
}) {
  return (
    <PdfJsViewer
      url={props.pdfUrl}
      initialPage={1}
      shareId={props.shareId}
      ai={props.ai}
      relevancyEnabled={props.relevancyEnabled}
      allowDownload={props.allowDownload}
      downloadUrl={props.downloadUrl}
      revisionHistoryEnabled={props.revisionHistoryEnabled}
      revisionHistoryUrl={props.revisionHistoryUrl}
    />
  );
}

