import { redirect } from "next/navigation";

/**
 * Backward-compatible redirect.
 *
 * We moved the demo under `/test/client-upload` so "test utilities" don't blend
 * into the primary product routes.
 */
export default function ClientUploadRedirectPage() {
  redirect("/test/client-upload");
}


