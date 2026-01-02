/**
 * Owner doc page (main view).
 * Route: `/doc/:docId`
 */
"use client";

import { use } from "react";
import DocPageClient from "./pageClient";

/**
 * App Router route entrypoint for `/doc/:docId`.
 *
 * Keep this client-first so navigation from `/` feels instant.
 * The actual state is hydrated/polled inside `pageClient.tsx` via `/api/docs/:docId`.
 */
export default function DocPage(props: { params: Promise<{ docId: string }> }) {
  const { docId } = use(props.params);

  return (
    <DocPageClient
      initialDoc={{
        id: docId,
        shareId: null,
        title: "Document",
        status: "preparing",
        currentUploadId: null,
        currentUploadVersion: null,
        blobUrl: null,
        previewImageUrl: null,
        extractedText: null,
        aiOutput: null,
        receiverRelevanceChecklist: false,
        shareAllowPdfDownload: false,
        sharePasswordEnabled: false,
      }}
    />
  );
}



