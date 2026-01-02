/**
 * Vercel Blob client-upload route (App Router).
 *
 * This route is called by the browser-side `upload()` helper in `@vercel/blob/client`.
 * Responsibilities:
 * - Mint short-lived client tokens (scoped to a pathname + constraints)
 * - Optionally receive the "upload completed" callback from Vercel
 *
 * Docs: https://vercel.com/docs/vercel-blob/client-upload
 */

import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import {
  CLIENT_UPLOAD_ALLOWED_CONTENT_TYPES,
  CLIENT_UPLOAD_MAX_SIZE_BYTES,
  assertAllowedTestPathname,
} from "@/lib/blob/serverClientUploadRoute";
import { debugError, debugLog } from "@/lib/debug";

export const runtime = "nodejs";
/**
 * Handle POST requests.
 */


export async function POST(request: Request) {
  try {
    debugLog(2, "[api/blob/upload] POST");
    // The SDK expects a JSON body in one of two event formats:
    // - blob.generate-client-token
    // - blob.upload-completed (callback)
    const body = (await request.json()) as HandleUploadBody;

    const jsonResponse = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async (pathname) => {
        // Safety gate: only allow uploads under our test prefix.
        assertAllowedTestPathname(pathname);

        debugLog(1, "[api/blob/upload] mint token", { pathname });
        return {
          allowedContentTypes: [...CLIENT_UPLOAD_ALLOWED_CONTENT_TYPES],
          maximumSizeInBytes: CLIENT_UPLOAD_MAX_SIZE_BYTES,
        };
      },
      // NOTE: We intentionally do NOT set `onUploadCompleted` here.
      // In local dev it causes a warning unless `VERCEL_BLOB_CALLBACK_URL` is set,
      // and our flow does not depend on callbacks (we update Mongo from the client).
    });

    return NextResponse.json(jsonResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/blob/upload] failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


