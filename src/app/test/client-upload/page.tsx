/**
 * Test route: Vercel Blob "client uploads"
 *
 * The real implementation lives in a reusable component under `src/components/`
 * so it can be embedded in other pages later.
 */

import BlobClientUploadTest from "@/components/BlobClientUploadTest";

export default function ClientUploadTestPage() {
  return <BlobClientUploadTest backHref="/" />;
}


