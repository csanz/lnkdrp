/**
 * "Replace file", for a document's sub-pages.
 *
 * The header band is meant to be the same wherever you are inside a document — the whole point of
 * `DocHeaderActions` — and it was not: the document page carried this control and its Metrics and
 * Links pages did not, so the cluster changed shape as you moved between them.
 *
 * The document page keeps its own copy rather than using this one, because it can do more: it
 * swaps in a local preview of the new file, tracks the pipeline's version and status inline, and
 * explains a failure in place. None of that has anywhere to render on a sub-page, and duplicating
 * it there would be duplicating the part most likely to drift.
 *
 * What a sub-page can do honestly is start the same replacement and take you to where its result
 * appears. That is what this does: the same API calls in the same order (`apiCreateUpload`, then
 * `startBlobUploadAndProcess`), then the document page, which is already built to show a
 * replacement in flight.
 */
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowPathIcon } from "@heroicons/react/24/outline";

import UploadButton from "@/components/UploadButton";
import { apiCreateUpload, startBlobUploadAndProcess } from "@/lib/client/docUploadPipeline";

export default function DocReplaceFileButton({ docId, disabled = false }: { docId: string; disabled?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <UploadButton
        label={busy ? "Starting…" : "Replace file"}
        accept="pdf"
        variant="link"
        icon={<ArrowPathIcon className="h-4 w-4" />}
        disabled={disabled || busy}
        onFileSelected={async (file) => {
          setBusy(true);
          setError(null);
          try {
            const created = await apiCreateUpload({
              docId,
              originalFileName: file.name,
              // Some platforms report an empty MIME type for a PDF; the pipeline wants one.
              contentType: file.type || "application/pdf",
              sizeBytes: file.size,
            });
            startBlobUploadAndProcess({ docId, uploadId: created.id, file });
            // The document page shows the new version arriving; there is nothing to watch here.
            router.push(`/doc/${encodeURIComponent(docId)}`);
          } catch (e) {
            // Said here rather than swallowed: the replacement never started, and the reason
            // ("Only PDF files are supported", a plan limit) is the useful half.
            setError(e instanceof Error ? e.message : "Could not start the replacement.");
            setBusy(false);
          }
        }}
      />
      {error ? (
        <span role="status" className="max-w-[220px] truncate text-[12px] text-[var(--danger-fg)]" title={error}>
          {error}
        </span>
      ) : null}
    </>
  );
}
