/**
 * Owner doc AI page (AI snapshot + related details).
 * Route: `/doc/:docId/ai`
 */
"use client";

import Link from "next/link";
import { use } from "react";
import { useEffect, useMemo, useState } from "react";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";

type DocDTO = {
  id: string;
  title: string | null;
  aiOutput?: unknown | null;
};
/**
 * Return whether record.
 */


function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
/**
 * As Non Empty String (uses trim).
 */


function asNonEmptyString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
/**
 * As String Array (uses isArray, map, filter).
 */


function asStringArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim())
    : [];
}
/**
 * Render the DocAiExtractPage UI (uses effects, memoized values, local state).
 */


export default function DocAiExtractPage(props: { params: Promise<{ docId: string }> }) {
  const { docId } = use(props.params);

  const [doc, setDoc] = useState<DocDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
/**
 * Load (updates state (setLoading, setError, setDoc); uses setLoading, setError, fetchWithTempUser).
 */

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetchWithTempUser(`/api/docs/${docId}`, { cache: "no-store" });
        if (!res.ok) {
          const json = (await res.json().catch(() => null)) as { error?: unknown } | null;
          throw new Error(typeof json?.error === "string" ? json.error : `Failed to load doc (${res.status})`);
        }
        const json = (await res.json()) as { doc?: unknown };
        const d = isRecord(json?.doc) ? json.doc : null;
        const next: DocDTO = {
          id: d && typeof d.id === "string" ? d.id : docId,
          title: d && typeof d.title === "string" ? d.title : null,
          aiOutput: d ? (d.aiOutput ?? null) : null,
        };
        if (!cancelled) setDoc(next);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load doc");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [docId]);

  const ai = useMemo(() => (doc?.aiOutput && typeof doc.aiOutput === "object" ? (doc.aiOutput as Record<string, unknown>) : null), [doc]);

  const snapshot = useMemo(() => {
    if (!ai) return null;
    return {
      one_liner: asNonEmptyString(ai.one_liner),
      why: asNonEmptyString(ai.core_problem_or_need),
      scope: asStringArray(ai.primary_capabilities_or_scope),
      context: asNonEmptyString(ai.intended_use_or_context),
      value: asNonEmptyString(ai.outcomes_or_value),
      status: asNonEmptyString(ai.maturity_or_status),
      ask: asNonEmptyString(ai.ask),
      metrics: asStringArray(ai.key_metrics),
      tags: asStringArray(ai.tags),
      summary: asNonEmptyString(ai.summary),
    };
  }, [ai]);
/**
 * Copy Json (updates state (setCopied); uses stringify, writeText, setCopied).
 */


  async function copyJson() {
    try {
      const text = JSON.stringify(doc?.aiOutput ?? null, null, 2);
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 900);
    } catch {
      // ignore
    }
  }

  return (
    <main className="min-h-screen bg-[var(--bg)] text-[var(--fg)]">
      <div className="mx-auto w-full max-w-4xl px-6 py-10">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm text-[var(--muted-2)]">
              <Link href={`/doc/${docId}`} className="font-semibold text-[var(--fg)] hover:underline">
                ← Back to doc
              </Link>
            </div>
            <h1 className="mt-3 truncate text-xl font-semibold tracking-tight">
              AI extract{doc?.title ? `: ${doc.title}` : ""}
            </h1>
            <div className="mt-2 text-sm text-[var(--muted)]">
              Full structured data captured from the document (owner-only).
            </div>
          </div>
          <button
            type="button"
            onClick={() => void copyJson()}
            className="shrink-0 rounded-lg bg-[var(--primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)]"
          >
            {copied ? "Copied" : "Copy JSON"}
          </button>
        </div>

        {loading ? <div className="mt-8 text-sm text-[var(--muted)]">Loading…</div> : null}
        {error ? (
          <div className="mt-8 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {error}
          </div>
        ) : null}

        {!loading && !error ? (
          <>
            {snapshot ? (
              <div className="mt-8 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
                <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                  Snapshot
                </div>

                {snapshot.one_liner ? (
                  <div className="mt-3 text-lg font-semibold text-[var(--fg)]">{snapshot.one_liner}</div>
                ) : null}

                {snapshot.summary ? (
                  <div className="mt-3 text-sm leading-relaxed text-[var(--muted)]">{snapshot.summary}</div>
                ) : null}

                <div className="mt-5 grid gap-4 md:grid-cols-2">
                  {snapshot.why ? (
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Why this exists</div>
                      <div className="mt-1 text-sm text-[var(--fg)]">{snapshot.why}</div>
                    </div>
                  ) : null}

                  {snapshot.context ? (
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Context</div>
                      <div className="mt-1 text-sm text-[var(--fg)]">{snapshot.context}</div>
                    </div>
                  ) : null}

                  {snapshot.value ? (
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Value</div>
                      <div className="mt-1 text-sm text-[var(--fg)]">{snapshot.value}</div>
                    </div>
                  ) : null}

                  {snapshot.status ? (
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Status</div>
                      <div className="mt-1 text-sm text-[var(--fg)]">{snapshot.status}</div>
                    </div>
                  ) : null}

                  {snapshot.ask ? (
                    <div className="md:col-span-2">
                      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Ask</div>
                      <div className="mt-1 text-sm text-[var(--fg)]">{snapshot.ask}</div>
                    </div>
                  ) : null}

                  {snapshot.scope.length ? (
                    <div className="md:col-span-2">
                      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Scope</div>
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--fg)]">
                        {snapshot.scope.slice(0, 12).map((s) => (
                          <li key={s}>{s}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {snapshot.metrics.length ? (
                    <div className="md:col-span-2">
                      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Key metrics</div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {snapshot.metrics.slice(0, 12).map((m) => (
                          <span
                            key={m}
                            className="rounded-full bg-[var(--panel-hover)] px-3 py-1 text-xs font-medium text-[var(--muted)] ring-1 ring-[var(--border)]"
                          >
                            {m}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {snapshot.tags.length ? (
                    <div className="md:col-span-2">
                      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Tags</div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {snapshot.tags.slice(0, 12).map((t) => (
                          <span
                            key={t}
                            className="rounded-full bg-[var(--panel-hover)] px-3 py-1 text-xs font-medium text-[var(--muted)] ring-1 ring-[var(--border)]"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className="mt-8 rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-5">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-[var(--fg)]">Raw JSON</div>
                <div className="text-xs text-[var(--muted-2)]">(matches stored aiOutput)</div>
              </div>
              <pre className="mt-4 overflow-auto rounded-xl bg-[var(--code-bg)] p-4 text-xs text-[var(--fg)] ring-1 ring-[var(--code-border)]">
                {JSON.stringify(doc?.aiOutput ?? null, null, 2)}
              </pre>
            </div>
          </>
        ) : null}
      </div>
    </main>
  );
}


