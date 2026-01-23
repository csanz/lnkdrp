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
 * `POST /api/blob/upload`
 *
 * Implements the Vercel Blob client-upload handshake: mints short-lived client upload tokens
 * (and may accept upload-completed callbacks, though we intentionally don't rely on them).
 * Errors: returns 400 with a readable message + traceId on validation/SDK failures.
 */
export async function POST(request: Request) {
  const traceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    // Unconditional dev log: if blob token minting breaks, uploads fail silently client-side.
    if (process.env.NODE_ENV !== "production") {
      console.log("[api/blob/upload] POST begin", { traceId });
    }
    debugLog(2, "[api/blob/upload] POST", { traceId });
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

        if (process.env.NODE_ENV !== "production") {
          console.log("[api/blob/upload] mint token", { traceId, pathname });
        }
        debugLog(1, "[api/blob/upload] mint token", { traceId, pathname });
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
    console.error("[api/blob/upload] failed", { traceId, message });
    debugError(1, "[api/blob/upload] failed", { traceId, message });
    return NextResponse.json({ error: message, traceId }, { status: 400 });
  }
}


