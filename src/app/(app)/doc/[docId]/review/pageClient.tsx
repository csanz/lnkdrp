"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import Markdown from "@/components/Markdown";

type ReviewDTO = {
  id: string;
  docId: string;
  uploadId: string | null;
  version: number | null;
  status: string | null;
  model: string | null;
  priorReviewVersion: number | null;
  outputMarkdown: string | null;
  createdDate: string | null;
  updatedDate: string | null;
};

type ReviewsApiResponse = {
  total: number;
  page: number;
  limit: number;
  reviews: ReviewDTO[];
};
/**
 * Render the DocReviewPageClient UI (uses effects, memoized values, local state).
 */


export default function DocReviewPageClient({ docId }: { docId: string }) {
  const [loading, setLoading] = useState(true);
  const [review, setReview] = useState<ReviewDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
/**
 * Refresh (updates state (setLoading, setError, setReview); uses setLoading, setError, fetchWithTempUser).
 */


  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithTempUser(`/api/docs/${docId}/reviews?latest=1`, { cache: "no-store" });
      if (res.status === 404) {
        setReview(null);
        return;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Request failed (${res.status})`);
      }
      const json = (await res.json()) as ReviewsApiResponse;
      setReview((json.reviews ?? [])[0] ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load review");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  const shouldPoll = useMemo(() => {
    const s = (review?.status ?? "").toLowerCase();
    return s === "queued" || s === "processing";
  }, [review?.status]);

  useEffect(() => {
    if (!shouldPoll) return;
    const id = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldPoll]);

  return (
    <main className="min-h-[100svh] bg-white text-zinc-900">
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-lg font-semibold tracking-tight">Quality review</div>
            <div className="mt-1 text-sm text-zinc-600">
              AI-generated, stored per upload version.
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Link
              href={`/doc/${docId}`}
              className="inline-flex items-center justify-center rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-800 hover:bg-zinc-50"
            >
              Back to doc
            </Link>
            <button
              type="button"
              onClick={() => void refresh()}
              className="inline-flex items-center justify-center rounded-lg bg-zinc-900 px-3 py-2 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={loading}
            >
              Refresh
            </button>
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-zinc-200 bg-white p-5">
          {error ? (
            <div className="text-sm text-red-700">{error}</div>
          ) : loading && !review ? (
            <div className="text-sm text-zinc-600">Loading…</div>
          ) : !review ? (
            <div className="text-sm text-zinc-600">No review found for this doc yet.</div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm font-semibold text-zinc-900">
                  Version {review.version ?? "-"}
                </div>
                <div className="text-xs font-medium text-zinc-500">
                  Status: <span className="text-zinc-700">{review.status ?? "-"}</span>
                  {review.model ? (
                    <>
                      {" "}
                      · Model: <span className="text-zinc-700">{review.model}</span>
                    </>
                  ) : null}
                </div>
              </div>

              {review.outputMarkdown ? (
                <Markdown className="mt-4 text-sm">{review.outputMarkdown}</Markdown>
              ) : (
                <div className="mt-4 text-sm text-zinc-600">No review output yet.</div>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}


