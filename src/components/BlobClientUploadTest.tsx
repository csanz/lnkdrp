"use client";

/**
 * UI component for testing Vercel Blob "client uploads".
 *
 * Client uploads send the file directly from the browser to Vercel Blob.
 * The server is only used to mint a short-lived upload token via `handleUpload`.
 *
 * Docs: https://vercel.com/docs/vercel-blob/client-upload
 */

import type { PutBlobResult } from "@vercel/blob";
import { upload } from "@vercel/blob/client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useNavigationLockWhile } from "@/app/providers";
import {
  BLOB_HANDLE_UPLOAD_URL,
  SAMPLE_UPLOADS,
  buildTestBlobPathname,
  fetchPublicFileAsFile,
} from "@/lib/blob/clientUpload";

type Progress = { loaded: number; total: number; percentage: number } | null;

export type BlobClientUploadTestProps = {
  /**
   * Where the "Back" link should point.
   */
  backHref?: string;
};
/**
 * Render the BlobClientUploadTest UI (uses memoized values, local state).
 */


export default function BlobClientUploadTest({
  backHref = "/",
}: BlobClientUploadTestProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<Progress>(null);
  const [result, setResult] = useState<PutBlobResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  // Keep test pages consistent with the main app behavior.
  useNavigationLockWhile(isUploading);

  const canUpload = useMemo(
    () => !isUploading && !!selectedFile,
    [isUploading, selectedFile],
  );

  /**
   * Upload a `File` to Vercel Blob using the client upload flow.
   *
   * Note: `upload()` internally calls our `handleUploadUrl` to mint a token,
   * then uploads the file directly to Blob using that token.
   */
  async function doUpload(file: File, label: string) {
    setIsUploading(true);
    setError(null);
    setResult(null);
    setProgress(null);

    try {
      const pathname = buildTestBlobPathname({ label, fileName: file.name });

      const blob = await upload(pathname, file, {
        // Vercel Blob client uploads must be public-accessible.
        access: "public",
        // Our server route that mints a scoped token.
        handleUploadUrl: BLOB_HANDLE_UPLOAD_URL,
        // Content-type is optional, but we pass it for clarity.
        contentType: file.type || undefined,
        // Progress callback for UI.
        onUploadProgress: (p) => setProgress(p),
      });

      setResult(blob);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <main className="min-h-screen bg-white px-6 py-10 text-zinc-900">
      <div className="mx-auto w-full max-w-2xl">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Vercel Blob Client Upload Test
            </h1>
            <p className="mt-1 text-sm text-zinc-600">
              Browser uploads directly to Blob using a token from{" "}
              <code className="rounded bg-zinc-100 px-1.5 py-0.5">
                {BLOB_HANDLE_UPLOAD_URL}
              </code>
              .
            </p>
          </div>

          <Link
            href={backHref}
            className="text-sm font-medium text-zinc-700 underline underline-offset-4 hover:text-zinc-900"
          >
            Back
          </Link>
        </div>

        <div className="mt-6 rounded-2xl border border-zinc-200 bg-white p-5">
          <div className="text-sm font-semibold">Upload a local file</div>
          <p className="mt-1 text-sm text-zinc-600">
            Allowed: images and PDFs.
          </p>

          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <input
              type="file"
              accept="application/pdf,image/*"
              className="block w-full text-sm"
              onChange={(e) => {
                setSelectedFile(e.target.files?.[0] ?? null);
                setResult(null);
                setError(null);
                setProgress(null);
              }}
              disabled={isUploading}
            />

            <button
              type="button"
              className="inline-flex items-center justify-center rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!canUpload}
              onClick={() => selectedFile && doUpload(selectedFile, "manual")}
            >
              {isUploading ? "Uploading…" : "Upload"}
            </button>
          </div>

          <div className="mt-6 border-t border-zinc-200 pt-5">
            <div className="text-sm font-semibold">Upload the bundled samples</div>
            <p className="mt-1 text-sm text-zinc-600">
              Uses{" "}
              <code className="rounded bg-zinc-100 px-1.5 py-0.5">fetch()</code>{" "}
              to load from{" "}
              <code className="rounded bg-zinc-100 px-1.5 py-0.5">/public</code>{" "}
              and uploads as a{" "}
              <code className="rounded bg-zinc-100 px-1.5 py-0.5">File</code>.
            </p>

            <div className="mt-4 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-full border border-zinc-300 bg-white px-5 py-2.5 text-sm font-medium text-zinc-900 shadow-sm transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={isUploading}
                onClick={async () => {
                  const file = await fetchPublicFileAsFile(SAMPLE_UPLOADS.image);
                  await doUpload(file, SAMPLE_UPLOADS.image.label);
                }}
              >
                Upload `skycatch.jpg`
              </button>

              <button
                type="button"
                className="inline-flex items-center justify-center rounded-full border border-zinc-300 bg-white px-5 py-2.5 text-sm font-medium text-zinc-900 shadow-sm transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={isUploading}
                onClick={async () => {
                  const file = await fetchPublicFileAsFile(SAMPLE_UPLOADS.pdf);
                  await doUpload(file, SAMPLE_UPLOADS.pdf.label);
                }}
              >
                Upload `usavx.pdf`
              </button>
            </div>
          </div>

          {progress ? (
            <div className="mt-6 rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-sm">
              <div className="flex items-center justify-between">
                <div className="font-medium">Upload progress</div>
                <div className="tabular-nums text-zinc-700">
                  {Math.round(progress.percentage)}%
                </div>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-200">
                <div
                  className="h-full bg-black"
                  style={{ width: `${progress.percentage}%` }}
                />
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
              {error}
            </div>
          ) : null}

          {result ? (
            <div className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
              <div className="font-medium">Uploaded!</div>
              <div className="mt-2 break-words">
                URL:{" "}
                <a
                  className="underline underline-offset-4"
                  href={result.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {result.url}
                </a>
              </div>
              <div className="mt-1 text-xs text-emerald-900/70">
                pathname: {result.pathname} · contentType: {result.contentType}
              </div>
            </div>
          ) : null}
        </div>

        <p className="mt-4 text-xs text-zinc-500">
          Note:{" "}
          <code className="rounded bg-zinc-100 px-1">onUploadCompleted</code>{" "}
          callbacks won’t fire on localhost unless you expose your dev server and
          set{" "}
          <code className="rounded bg-zinc-100 px-1">
            VERCEL_BLOB_CALLBACK_URL
          </code>
          . See{" "}
          <a
            className="underline underline-offset-4"
            href="https://vercel.com/docs/vercel-blob/client-upload"
            target="_blank"
            rel="noreferrer"
          >
            Vercel Blob Client Uploads
          </a>
          .
        </p>
      </div>
    </main>
  );
}






