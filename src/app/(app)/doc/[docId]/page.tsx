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
        /**
         * Deliberately empty, not the word "Document".
         *
         * This route is client-first and does no server read, so whatever is written here is what
         * the header renders until `/api/docs/:id` answers — and a placeholder that *looks like a
         * name* is the flash this page used to have on every navigation. The client fills the real
         * name from `useEntityTitle` (`src/lib/client/entityTitles.ts`) on its first frame instead.
         */
        title: "",
        status: "preparing",
        currentUploadId: null,
        currentUploadVersion: null,
        blobUrl: null,
        previewImageUrl: null,
        extractedText: null,
        aiOutput: null,
        receiverRelevanceChecklist: false,
        shareAllowPdfDownload: false,
        shareAllowRevisionHistory: false,
        sharePasswordEnabled: false,
      }}
    />
  );
}



