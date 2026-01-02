/**
 * Admin route: `/a/data/projects/:projectId`
 *
 * Allows admin to inspect and update a project (including setting `isRequest=true`).
 */
"use client";

import { signIn, useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

type ProjectRaw = Record<string, unknown>;

export default function AdminProjectEditorPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = decodeURIComponent(params?.projectId ?? "").trim();

  const { data: session, status } = useSession();
  const role = session?.user?.role ?? null;
  const isAuthed = status === "authenticated";
  const isAdmin = isAuthed && role === "admin";
  const isLocalhost =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  const canUseAdmin = isAdmin || isLocalhost;

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMessage, setOkMessage] = useState<string | null>(null);
  const [raw, setRaw] = useState<ProjectRaw | null>(null);

  const token = useMemo(() => {
    const t = raw?.requestUploadToken;
    return typeof t === "string" ? t : null;
  }, [raw]);
  const currentIsRequest = useMemo(() => Boolean(raw?.isRequest), [raw]);

  const [draftIsRequest, setDraftIsRequest] = useState<boolean>(false);

  useEffect(() => {
    setDraftIsRequest(currentIsRequest);
  }, [currentIsRequest]);

  useEffect(() => {
    if (!canUseAdmin) return;
    if (!projectId) return;
    setLoading(true);
    setError(null);
    setOkMessage(null);
    void (async () => {
      try {
        const res = await fetch(`/api/admin/data/projects/${encodeURIComponent(projectId)}`, { method: "GET" });
        const data = (await res.json().catch(() => ({}))) as { error?: unknown; project?: { raw?: unknown } };
        if (!res.ok) {
          setError(typeof data.error === "string" ? data.error : "Failed to load project");
          setRaw(null);
          return;
        }
        const r = data.project?.raw;
        setRaw(r && typeof r === "object" ? (r as ProjectRaw) : null);
      } catch {
        setError("Failed to load project");
        setRaw(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [canUseAdmin, projectId]);

  async function onSave() {
    setError(null);
    setOkMessage(null);
    if (!projectId) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/data/projects/${encodeURIComponent(projectId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isRequest: draftIsRequest }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: unknown; ok?: unknown };
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Failed to update project");
        return;
      }
      setOkMessage("Saved.");
      // Refresh raw so admin sees persisted truth.
      const again = await fetch(`/api/admin/data/projects/${encodeURIComponent(projectId)}`, { method: "GET" });
      const againJson = (await again.json().catch(() => ({}))) as { project?: { raw?: unknown } };
      const r = againJson.project?.raw;
      setRaw(r && typeof r === "object" ? (r as ProjectRaw) : null);
    } finally {
      setSaving(false);
    }
  }

  async function convertToRequestRepo() {
    setError(null);
    setOkMessage(null);
    if (!projectId) return;
    const ok = window.confirm("Convert this project into a request repository?\n\nThis will generate a request upload token and set isRequest=true.");
    if (!ok) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/data/projects/${encodeURIComponent(projectId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ convertToRequest: true }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: unknown };
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Failed to convert project");
        return;
      }
      setOkMessage("Converted to request repository.");
      const again = await fetch(`/api/admin/data/projects/${encodeURIComponent(projectId)}`, { method: "GET" });
      const againJson = (await again.json().catch(() => ({}))) as { project?: { raw?: unknown } };
      const r = againJson.project?.raw;
      setRaw(r && typeof r === "object" ? (r as ProjectRaw) : null);
    } finally {
      setSaving(false);
    }
  }

  if (status === "loading") {
    return <div className="px-6 py-8 text-sm text-[var(--muted)]">Loading…</div>;
  }

  if (!isAuthed && !isLocalhost) {
    return (
      <div className="px-6 py-10">
        <div className="max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Data / Projects</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">You must be signed in to view this page.</p>
          <div className="mt-5">
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-xl bg-[var(--primary-bg)] px-5 py-2.5 text-sm font-semibold text-[var(--primary-fg)] shadow-sm transition hover:bg-[var(--primary-hover-bg)]"
              onClick={() => void signIn("google", { callbackUrl: `/a/data/projects/${encodeURIComponent(projectId)}` })}
            >
              Sign in
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!canUseAdmin) {
    return (
      <div className="px-6 py-10">
        <div className="max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Data / Projects</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">You don’t have access to this page.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className="mx-auto w-full max-w-4xl px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-[var(--fg)]">Admin / Data / Projects</h1>
            <p className="mt-1 text-sm text-[var(--muted)]">Project editor</p>
          </div>
          <Link
            href="/a/data/projects"
            className="rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)]"
          >
            Back to list
          </Link>
        </div>

        <div className="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
          {loading ? (
            <div className="text-sm text-[var(--muted)]">Loading…</div>
          ) : error ? (
            <div className="text-sm text-red-700">{error}</div>
          ) : raw ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Project ID</div>
                  <div className="mt-1 font-mono text-xs text-[var(--muted)]">{projectId}</div>
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Token</div>
                  <div className="mt-1 font-mono text-xs text-[var(--muted)]">
                    {token ? `${token.slice(0, 12)}…` : "—"}
                  </div>
                </div>
              </div>

              <div className="mt-5 flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
                <div>
                  <div className="text-sm font-semibold text-[var(--fg)]">isRequest</div>
                  <div className="mt-1 text-sm text-[var(--muted)]">
                    Marks this project as a request repository (Received).
                  </div>
                </div>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draftIsRequest}
                    onChange={(e) => setDraftIsRequest(e.target.checked)}
                    className="h-4 w-4 accent-black"
                  />
                  <span className="text-sm font-medium text-[var(--fg)]">{draftIsRequest ? "True" : "False"}</span>
                </label>
              </div>

              {!token ? (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-3">
                  <div className="text-sm text-[var(--muted)]">
                    This project has no request token. Convert it to enable `/request/:token` uploads.
                  </div>
                  <button
                    type="button"
                    disabled={saving || loading}
                    className="rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => void convertToRequestRepo()}
                  >
                    Convert to request repo
                  </button>
                </div>
              ) : null}

              {okMessage ? <div className="mt-3 text-sm text-[var(--fg)]">{okMessage}</div> : null}

              <div className="mt-5 flex items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={saving || loading || (draftIsRequest && !token)}
                  className="rounded-xl bg-black px-4 py-2 text-sm font-semibold text-white hover:bg-black/90 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => void onSave()}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>

              <details className="mt-6">
                <summary className="cursor-pointer text-sm font-semibold text-[var(--fg)]">Raw project JSON</summary>
                <pre className="mt-3 overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-4 text-xs text-[var(--fg)]">
                  {JSON.stringify(raw, null, 2)}
                </pre>
              </details>
            </>
          ) : (
            <div className="text-sm text-[var(--muted)]">No data.</div>
          )}
        </div>
      </div>
    </div>
  );
}


