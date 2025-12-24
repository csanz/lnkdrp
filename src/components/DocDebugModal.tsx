"use client";

import { useEffect, useMemo, useState } from "react";
import Modal from "@/components/modals/Modal";

type DebugApiResponse = {
  debug?: {
    enabled?: boolean;
    doc?: unknown;
    currentUpload?: unknown;
    uploads?: unknown;
  };
  error?: string;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function formatJson(v: unknown) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function asArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

function KeyValueTable({ value }: { value: unknown }) {
  const entries = useMemo(() => {
    if (!isPlainObject(value)) return null;
    return Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  }, [value]);

  if (!entries) {
    return (
      <pre className="whitespace-pre-wrap break-words rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-800">
        {formatJson(value)}
      </pre>
    );
  }

  return (
    <div className="space-y-2">
      {entries.map(([k, v]) => {
        const isPrimitive =
          v === null || ["string", "number", "boolean"].includes(typeof v);
        return (
          <div key={k} className="rounded-lg border border-zinc-200 bg-white">
            <div className="flex items-baseline justify-between gap-3 border-b border-zinc-100 px-3 py-2">
              <div className="min-w-0 truncate font-mono text-xs font-semibold text-zinc-800">
                {k}
              </div>
            </div>
            <div className="px-3 py-2">
              {isPrimitive ? (
                <div className="text-sm text-zinc-900 break-words">
                  {typeof v === "string" ? v : String(v)}
                </div>
              ) : (
                <pre className="whitespace-pre-wrap break-words rounded-md bg-zinc-50 p-2 text-xs text-zinc-800">
                  {formatJson(v)}
                </pre>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function DocDebugModal({
  open,
  docId,
  onClose,
}: {
  open: boolean;
  docId: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"doc" | "uploads">("doc");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [debug, setDebug] = useState<DebugApiResponse["debug"] | null>(null);

  useEffect(() => {
    if (!open) return;
    setTab("doc");
    setLoading(true);
    setError(null);
    setDebug(null);

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/docs/${docId}?debug=1`, { cache: "no-store" });
        const json = (await res.json().catch(() => ({}))) as DebugApiResponse;
        if (cancelled) return;
        if (!res.ok) throw new Error(json?.error || "Failed to load debug data");
        setDebug(json.debug ?? null);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to load debug data";
        if (!cancelled) setError(msg);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, docId]);

  const tabButton = (id: "doc" | "uploads", label: string) => (
    <button
      type="button"
      onClick={() => setTab(id)}
      className={
        tab === id
          ? "rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white"
          : "rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-800 hover:bg-zinc-50"
      }
    >
      {label}
    </button>
  );

  return (
    <Modal open={open} ariaLabel="Debug data" onClose={onClose} panelClassName="w-[min(860px,calc(100vw-32px))]">
      <div className="text-base font-semibold text-zinc-900">Debug data</div>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {tabButton("doc", "Docs")}
          {tabButton("uploads", "Uploads")}
        </div>
        <div className="text-xs text-zinc-500">
          {loading ? "Loading…" : debug?.enabled ? "Debug enabled" : ""}
        </div>
      </div>

      {error ? (
        <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700">
          Fetching full doc + upload records…
        </div>
      ) : null}

      {!loading && !error ? (
        <div className="mt-3">
          {tab === "doc" ? (
            <KeyValueTable value={debug?.doc ?? null} />
          ) : (
            <UploadsView uploads={debug?.uploads} currentUpload={debug?.currentUpload} />
          )}
        </div>
      ) : null}
    </Modal>
  );
}

function UploadsView({
  uploads,
  currentUpload,
}: {
  uploads: unknown;
  currentUpload: unknown;
}) {
  const arr = asArray(uploads);
  if (!arr) return <KeyValueTable value={uploads ?? currentUpload ?? null} />;

  return (
    <div className="space-y-2">
      {arr.length === 0 ? (
        <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700">
          No uploads found for this doc.
        </div>
      ) : null}

      {arr.map((u, idx) => {
        const obj = isPlainObject(u) ? u : null;
        const id =
          obj && (typeof obj._id === "string" || typeof obj.id === "string")
            ? String((obj._id ?? obj.id) as string)
            : null;
        const status = obj && typeof obj.status === "string" ? obj.status : null;
        const version = obj && Number.isFinite(obj.version as number) ? (obj.version as number) : null;

        return (
          <details
            key={id ?? idx}
            className="rounded-xl border border-zinc-200 bg-white open:shadow-sm"
          >
            <summary className="cursor-pointer select-none px-3 py-2 text-sm font-semibold text-zinc-900">
              <span className="mr-2 text-zinc-500">#{arr.length - idx}</span>
              {version ? <span className="mr-2">v{version}</span> : null}
              {status ? <span className="mr-2">{status}</span> : null}
              {id ? <span className="font-mono text-xs text-zinc-600">{id}</span> : null}
            </summary>
            <div className="px-3 pb-3">
              <KeyValueTable value={u} />
            </div>
          </details>
        );
      })}
    </div>
  );
}



