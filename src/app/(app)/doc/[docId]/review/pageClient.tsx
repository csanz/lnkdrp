"use client";

import { useEffect, useMemo, useState } from "react";

/** 20 quick polls (30 s) plus 114 slow ones (9.5 min): about ten minutes, then the page stops asking. */
const REVIEW_POLL_MAX_TRIES = 134;
import Link from "next/link";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import Markdown from "@/components/Markdown";
import { dispatchOutOfCredits, outOfCreditsReasonFromCode } from "@/lib/client/outOfCredits";

type QualityDefaults = {
  ok: true;
  review: "basic" | "standard" | "advanced";
  history: "basic" | "standard" | "advanced";
};

type ReviewDTO = {
  id: string;
  docId: string;
  uploadId: string | null;
  version: number | null;
  status: string | null;
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
  const [runBusy, setRunBusy] = useState(false);
  const [quality, setQuality] = useState<"basic" | "standard" | "advanced">("standard");

  // Load workspace defaults (best-effort). Falls back to "standard".
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/credits/quality-defaults", { method: "GET" });
        const json = (await res.json().catch(() => null)) as QualityDefaults | { error?: string } | null;
        if (!res.ok) return;
        if (!json || (json as any).ok !== true) return;
        const t = (json as any).review;
        if (!cancelled && (t === "basic" || t === "standard" || t === "advanced")) setQuality(t);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  type DocMeta = { currentUploadId: string | null; currentUploadVersion: number | null };
  const [docMeta, setDocMeta] = useState<DocMeta>({ currentUploadId: null, currentUploadVersion: null });
/**
 * Refresh (updates state (setLoading, setError, setReview); uses setLoading, setError, fetchWithTempUser).
 */


  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [docRes, reviewRes] = await Promise.all([
        // `lite=1`: the page needs the current upload's id and version, not the extracted text of
        // the whole document, and this request repeats while a review is running.
        fetchWithTempUser(`/api/docs/${encodeURIComponent(docId)}?lite=1`, { cache: "no-store" }),
        fetchWithTempUser(`/api/docs/${encodeURIComponent(docId)}/reviews?latest=1`, { cache: "no-store" }),
      ]);

      if (docRes.ok) {
        const json = (await docRes.json().catch(() => null)) as any;
        const u = json && typeof json === "object" ? (json as any).doc : null;
        const currentUploadId = typeof u?.currentUploadId === "string" ? u.currentUploadId : null;
        const currentUploadVersion =
          typeof u?.currentUploadVersion === "number" && Number.isFinite(u.currentUploadVersion) ? u.currentUploadVersion : null;
        setDocMeta({ currentUploadId, currentUploadVersion });
      }

      const res = reviewRes;
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
    // Quick at first, then every few seconds, and not forever: a review that has not finished in
    // ten minutes is not going to be caught by this page; a reload asks again.
    let cancelled = false;
    let tries = 0;
    let timer: number | null = null;
    const tick = async () => {
      if (cancelled) return;
      tries += 1;
      await refresh();
      if (cancelled || tries >= REVIEW_POLL_MAX_TRIES) return;
      timer = window.setTimeout(tick, tries < 20 ? 1500 : 5000);
    };
    timer = window.setTimeout(tick, 1500);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldPoll]);

  return (
    // Pinned to raw zinc, this page punched a full-height white sheet (with a black-on-dark CTA)
    // into the themed app shell in dark, and ignored the light ramp in light. It is an owner-facing
    // route inside (app), not one of the deliberately always-dark recipient surfaces.
    <main className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-lg font-semibold tracking-tight">AI review</div>
            <div className="mt-1 text-sm text-[var(--muted)]">
              AI-generated, stored per upload version.
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Link
              href={`/doc/${docId}`}
              className="inline-flex items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)]"
            >
              Back to doc
            </Link>
            <div className="flex items-center gap-2">
              <select
                className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm font-semibold text-[var(--fg)]"
                value={quality}
                onChange={(e) => setQuality(e.target.value as any)}
                aria-label="AI review quality"
              >
                <option value="basic">Basic (2 credits)</option>
                <option value="standard">Standard (5 credits)</option>
                <option value="advanced">Advanced (12 credits)</option>
              </select>
              <button
                type="button"
                onClick={() => {
                  const uploadId = docMeta.currentUploadId;
                  if (!uploadId) {
                    setError("Missing current upload id for this doc.");
                    return;
                  }
                  const idKey =
                    typeof crypto !== "undefined" && "randomUUID" in crypto ? (crypto as any).randomUUID() : String(Date.now());
                  void (async () => {
                    try {
                      setRunBusy(true);
                      setError(null);
                      const qs = new URLSearchParams();
                      qs.set("forceReview", "1");
                      qs.set("quality", quality);
                      const res = await fetchWithTempUser(`/api/uploads/${encodeURIComponent(uploadId)}/process?${qs.toString()}`, {
                        method: "POST",
                        headers: { "x-idempotency-key": idKey },
                      });
                      if (res.status === 402) {
                        const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
                        dispatchOutOfCredits(outOfCreditsReasonFromCode(body?.code));
                        return;
                      }
                      if (!res.ok) {
                        const j = (await res.json().catch(() => null)) as any;
                        throw new Error(j?.error || `Request failed (${res.status})`);
                      }
                      await refresh();
                    } catch (e) {
                      setError(e instanceof Error ? e.message : "Failed to run review");
                    } finally {
                      setRunBusy(false);
                    }
                  })();
                }}
                className="inline-flex items-center justify-center rounded-lg bg-[var(--primary-bg)] px-3 py-2 text-sm font-semibold text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)] disabled:cursor-not-allowed disabled:opacity-60"
                disabled={loading || runBusy}
                title="Run a new review for the current version"
              >
                {runBusy ? "Running…" : "Run review"}
              </button>
            </div>
            <button
              type="button"
              onClick={() => void refresh()}
              className="inline-flex items-center justify-center rounded-lg bg-[var(--primary-bg)] px-3 py-2 text-sm font-semibold text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)] disabled:cursor-not-allowed disabled:opacity-60"
              disabled={loading}
            >
              Refresh
            </button>
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5 shadow-[var(--shadow-card)]">
          {error ? (
            <div className="text-sm text-[var(--danger-fg)]">{error}</div>
          ) : loading && !review ? (
            <div className="text-sm text-[var(--muted)]">Loading…</div>
          ) : !review ? (
            <div className="text-sm text-[var(--muted)]">No review found for this doc yet.</div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm font-semibold text-[var(--fg)]">
                  Version {review.version ?? "-"}
                </div>
                <div className="text-xs font-medium text-[var(--muted-2)]">
                  Status: <span className="text-[var(--muted)]">{review.status ?? "-"}</span>
                </div>
              </div>

              {review.outputMarkdown ? (
                <Markdown className="mt-4 text-sm">{review.outputMarkdown}</Markdown>
              ) : (
                <div className="mt-4 text-sm text-[var(--muted)]">No review output yet.</div>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}


