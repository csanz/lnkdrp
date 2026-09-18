"use client";

/**
 * ChangePreviewModal — what changed in one replacement, opened from the Activity feed.
 *
 * A "replaced" row said a new version exists and nothing about it, so the only way to learn what
 * moved was to open the document, find History, and read the entry. This is that entry, in place:
 * the AI compare summary for that version, the pages it touched, and a way into the full history.
 *
 * Not plan-gated. The owner's version history is open on every plan; AI compare is what costs
 * credits, so a workspace that was out of credits when the file landed has a version with no
 * summary yet — this says so and offers to run it later from the document, rather than implying
 * the history itself is missing or locked.
 */
import Link from "next/link";
import { useEffect, useState } from "react";

import Modal from "@/components/modals/Modal";
import Alert from "@/components/ui/Alert";
import { formatSizeChangeLine } from "@/lib/format/bytes";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";

type DocChange = {
  id: string;
  fromVersion: number | null;
  toVersion: number | null;
  summary: string;
  changes: string[];
  pagesThatChanged: number[];
  createdDate: string | null;
  /** The file's own facts, so a replaced deck can say it got lighter. Null where never recorded. */
  fromSizeBytes: number | null;
  toSizeBytes: number | null;
  toPages: number | null;
};

/** Parse one change row defensively: this payload is best-effort and older rows are sparse. */
function parseChange(raw: unknown): DocChange | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : "";
  if (!id) return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const changes = Array.isArray(r.changes)
    ? r.changes
        .map((c) => (typeof c === "string" ? c.trim() : typeof (c as { summary?: unknown })?.summary === "string" ? String((c as { summary: string }).summary).trim() : ""))
        .filter(Boolean)
    : [];
  const pages = Array.isArray(r.pagesThatChanged)
    ? r.pagesThatChanged
        .map((p) => (typeof p === "number" ? p : typeof (p as { pageNumber?: unknown })?.pageNumber === "number" ? (p as { pageNumber: number }).pageNumber : null))
        .filter((p): p is number => typeof p === "number" && Number.isFinite(p))
    : [];
  return {
    id,
    fromVersion: num(r.fromVersion),
    toVersion: num(r.toVersion),
    summary: typeof r.summary === "string" ? r.summary.trim() : "",
    changes,
    pagesThatChanged: pages,
    createdDate: typeof r.createdDate === "string" ? r.createdDate : null,
    fromSizeBytes: num(r.fromSizeBytes),
    toSizeBytes: num(r.toSizeBytes),
    toPages: num(r.toPages),
  };
}

export default function ChangePreviewModal({
  open,
  onClose,
  docId,
  docTitle,
  version,
}: {
  open: boolean;
  onClose: () => void;
  docId: string;
  docTitle: string;
  /** The version the feed row announced; the matching change is preferred over the newest one. */
  version: number | null;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [change, setChange] = useState<DocChange | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        // `noText=1`: the modal shows the summary, never the extracted page text, and that text is
        // by far the heaviest part of the payload.
        const res = await fetchWithTempUser(
          `/api/docs/${encodeURIComponent(docId)}/changes?limit=10&noText=1`,
          { cache: "no-store" },
        );
        const json = (await res.json().catch(() => null)) as { changes?: unknown } | null;
        if (!res.ok) throw new Error("Could not load this version's history.");
        const rows = Array.isArray(json?.changes) ? json!.changes.map(parseChange).filter((c): c is DocChange => c !== null) : [];
        const match = version === null ? rows[0] ?? null : rows.find((c) => c.toVersion === version) ?? null;
        if (!cancelled) {
          setChange(match);
          setLoaded(true);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load this version's history.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, docId, version]);

  const from = change?.fromVersion ?? (typeof version === "number" ? version - 1 : null);
  const to = change?.toVersion ?? version;
  const versionLine = from !== null && to !== null ? `v${from} → v${to}` : to !== null ? `v${to}` : "";
  // The file itself: its new size, how far it moved from the previous version, and its page count.
  // Shown whether or not an AI compare ran — the bytes are a fact we always have.
  const fileLine = (function () {
    const size = formatSizeChangeLine(change?.fromSizeBytes ?? null, change?.toSizeBytes ?? null);
    if (!size) return null;
    const pages = typeof change?.toPages === "number" && change.toPages > 0 ? change.toPages : null;
    return pages ? `${size} · ${pages} page${pages === 1 ? "" : "s"}` : size;
  })();

  return (
    <Modal open={open} onClose={onClose} ariaLabel="What changed" width={560}>
      <div className="pr-10">
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--muted-2)]">What changed</div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
          <span className="text-[18px] font-semibold tracking-tight text-[var(--fg)]">{docTitle}</span>
          {versionLine ? <span className="text-[13px] font-medium tabular-nums text-[var(--muted-2)]">{versionLine}</span> : null}
        </div>
        {fileLine ? (
          <div className="mt-1 text-[12px] tabular-nums text-[var(--muted-2)]" title="The file itself">
            {fileLine}
          </div>
        ) : null}
      </div>

      {error ? (
        <Alert variant="error" className="mt-4 text-[12px]">
          {error}
        </Alert>
      ) : null}

      {loading && !loaded ? (
        <div className="mt-4 space-y-2" aria-hidden="true">
          <div className="h-4 w-3/4 animate-pulse rounded bg-[var(--panel-2)]" />
          <div className="h-4 w-full animate-pulse rounded bg-[var(--panel-2)]" />
          <div className="h-4 w-2/3 animate-pulse rounded bg-[var(--panel-2)]" />
        </div>
      ) : null}

      {loaded && !error ? (
        change?.summary ? (
          <>
            <p className="mt-4 text-[13px] leading-6 text-[var(--fg)]">{change.summary}</p>
            {change.changes.length ? (
              <ul className="mt-3 grid gap-1.5 text-[13px] leading-5 text-[var(--muted)]">
                {change.changes.slice(0, 5).map((c, i) => (
                  <li key={i} className="flex gap-2">
                    <span aria-hidden="true" className="text-[var(--muted-2)]">
                      ·
                    </span>
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {change.pagesThatChanged.length ? (
              <div className="mt-4 flex flex-wrap items-center gap-1.5">
                <span className="text-[12px] text-[var(--muted-2)]">Pages changed</span>
                {change.pagesThatChanged.slice(0, 12).map((p) => (
                  <span
                    key={p}
                    className="rounded-md bg-[var(--panel-2)] px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-[var(--fg)]"
                  >
                    {p}
                  </span>
                ))}
                {change.pagesThatChanged.length > 12 ? (
                  <span className="text-[12px] text-[var(--muted-2)]">+{change.pagesThatChanged.length - 12} more</span>
                ) : null}
              </div>
            ) : null}
          </>
        ) : (
          // No summary: either the version predates AI compare, or the workspace had no credits
          // when the file landed. Both are recoverable from the document, and neither is a lock.
          <div className="mt-4 rounded-xl bg-[var(--panel-2)] p-4 text-[13px] leading-6 text-[var(--muted)]">
            The version was recorded, but no AI compare has run for it yet — it is skipped when a
            workspace is out of credits. You can run it from the document&apos;s history at any time.
          </div>
        )
      ) : null}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <Link
          href={`/doc/${encodeURIComponent(docId)}/history`}
          className="text-[13px] font-medium text-[var(--fg)] underline-offset-4 hover:underline"
          onClick={onClose}
        >
          Open full history →
        </Link>
        <button
          type="button"
          className="rounded-xl bg-[var(--panel-hover)] px-4 py-2 text-[13px] font-semibold text-[var(--fg)]"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </Modal>
  );
}
