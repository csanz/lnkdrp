"use client";

import Link from "next/link";
import { signIn, useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";

type ShareViewItem = {
  _id: string;
  shareId?: string | null;
  docId?: { _id?: string; title?: string | null; shareId?: string | null } | string | null;
  pagesSeen?: number[] | null;
  createdDate?: string | null;
  updatedDate?: string | null;
  viewerEmail?: string | null;
  viewerUserId?: { _id?: string; email?: string | null; name?: string | null } | string | null;
};

function fmtDate(v: string | null | undefined) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.valueOf())) return v;
  return d.toLocaleString();
}

function viewerLabel(item: ShareViewItem) {
  const email = item.viewerEmail ?? null;
  if (email) return email;
  const u = item.viewerUserId && typeof item.viewerUserId === "object" ? item.viewerUserId : null;
  if (u?.email) return u.email;
  if (u?.name) return u.name;
  return "anonymous";
}

function docInfo(item: ShareViewItem): { title: string; shareId: string | null } {
  if (item.docId && typeof item.docId === "object") {
    const title = typeof item.docId.title === "string" && item.docId.title.trim() ? item.docId.title : "(untitled)";
    const shareId = typeof item.docId.shareId === "string" ? item.docId.shareId : null;
    return { title, shareId };
  }
  return { title: "(unknown doc)", shareId: typeof item.shareId === "string" ? item.shareId : null };
}

export default function ShareViewsDocAdminPage({ params }: { params: { docId: string } }) {
  const docId = params.docId;
  const { data: session, status } = useSession();
  const role = session?.user?.role ?? null;
  const isAuthed = status === "authenticated";
  const isAdmin = isAuthed && role === "admin";
  const isLocalhost =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  const canUseAdmin = isAdmin || isLocalhost;

  const [items, setItems] = useState<ShareViewItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalized = useMemo(() => (Array.isArray(items) ? items : []), [items]);
  const header = useMemo(() => (normalized.length ? docInfo(normalized[0]) : null), [normalized]);

  useEffect(() => {
    if (!canUseAdmin) return;
    if (!docId) return;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/admin/shareviews/doc/${encodeURIComponent(docId)}`, { method: "GET" });
        const data = (await res.json().catch(() => ({}))) as { error?: unknown; items?: unknown };
        if (!res.ok) {
          setError(typeof data.error === "string" ? data.error : "Failed to load share views");
          setItems([]);
          return;
        }
        setItems(Array.isArray(data.items) ? (data.items as ShareViewItem[]) : []);
      } catch {
        setError("Failed to load share views");
        setItems([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [canUseAdmin, docId]);

  if (status === "loading") {
    return <div className="px-6 py-8 text-sm text-[var(--muted)]">Loading…</div>;
  }

  if (!isAuthed && !isLocalhost) {
    return (
      <div className="px-6 py-10">
        <div className="max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Share views</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">You must be signed in to view this page.</p>
          <div className="mt-5">
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-xl bg-[var(--primary-bg)] px-5 py-2.5 text-sm font-semibold text-[var(--primary-fg)] shadow-sm transition hover:bg-[var(--primary-hover-bg)]"
              onClick={() => void signIn("google", { callbackUrl: `/a/shareviews/${encodeURIComponent(docId)}` })}
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
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Share views</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">You don’t have access to this page.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className="mx-auto w-full max-w-5xl px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-[var(--fg)]">
              Admin / Share views / {header?.title ?? "Document"}
            </h1>
            <p className="mt-1 text-sm text-[var(--muted)]">All distinct viewers for this doc.</p>
          </div>

          <div className="flex items-center gap-2">
            <Link
              href="/a/shareviews"
              className="inline-flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-2 text-sm font-semibold text-[var(--fg)] transition hover:bg-[var(--panel-hover)]"
            >
              Back
            </Link>
            {header?.shareId ? (
              <a
                href={`/s/${encodeURIComponent(header.shareId)}`}
                className="inline-flex items-center justify-center rounded-xl bg-[var(--primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--primary-fg)] shadow-sm transition hover:bg-[var(--primary-hover-bg)]"
                target="_blank"
                rel="noreferrer"
              >
                Open share
              </a>
            ) : null}
          </div>
        </div>

        {error ? (
          <div className="mt-5 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        {loading ? (
          <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
            Loading…
          </div>
        ) : normalized.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
            No views for this doc yet.
          </div>
        ) : (
          <div className="mt-6 space-y-3">
            {normalized.map((v) => {
              const viewedAt = fmtDate(v.updatedDate ?? v.createdDate ?? null);
              const pages = Array.isArray(v.pagesSeen) ? v.pagesSeen.length : 0;
              const viewer = viewerLabel(v);
              return (
                <div
                  key={v._id}
                  className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-[var(--fg)]">{viewer}</div>
                      <div className="mt-1 text-xs text-[var(--muted-2)]">
                        Last seen: {viewedAt} • Pages seen: {pages}
                      </div>
                    </div>
                    {v.shareId ? (
                      <a
                        href={`/s/${encodeURIComponent(v.shareId)}`}
                        className="inline-flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-2 text-sm font-semibold text-[var(--fg)] transition hover:bg-[var(--panel-hover)]"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open share
                      </a>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}


