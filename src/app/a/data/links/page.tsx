/**
 * Admin route: `/a/data/links`
 *
 * Share-link browser: every public link across every workspace, paged, with the settings support
 * actually gets asked about (password set, download allowed, expiry, disabled) and the link's own
 * view/download counters. Read-only — nothing here changes a link.
 */
"use client";

import Link from "next/link";
import { signIn, useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import Button from "@/components/ui/Button";
import DataTable from "@/components/ui/DataTable";
import Input from "@/components/ui/Input";
import Select from "@/components/ui/Select";
import { fmtDate } from "@/lib/admin/format";
import { linkStateLabel, publicLinkPath, type AdminLinkState } from "@/lib/admin/linksAdmin";
import { fetchJson } from "@/lib/http/fetchJson";

type LinkRow = {
  id: string;
  kind: string;
  shareId: string | null;
  label: string | null;
  audience: string | null;
  isDefault: boolean;
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceType: string | null;
  docId: string | null;
  docTitle: string | null;
  projectId: string | null;
  projectName: string | null;
  state: AdminLinkState;
  disabledByDocSwitch: boolean;
  allowDownload: boolean;
  hasPassword: boolean;
  expiresAt: string | null;
  createdVia: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  downloadCount: number;
  createdDate: string | null;
};

type SortField = "createdDate" | "lastViewedAt" | "viewCount";
type SortOrder = "desc" | "asc";

/** Column count of the table below; the empty row's colSpan has to match it exactly. */
const COLUMN_COUNT = 12;

/** Pill colours per state, so a disabled or expired link is visible at a glance in a long page. */
const STATE_CLASS: Record<AdminLinkState, string> = {
  active: "border-[var(--border)] bg-[var(--panel-2)] text-[var(--muted-2)]",
  disabled: "border-[var(--border)] bg-[var(--panel-2)] text-amber-700",
  expired: "border-[var(--border)] bg-[var(--panel-2)] text-amber-700",
  archived: "border-[var(--border)] bg-[var(--panel-2)] text-red-700",
};

/** The Links browser: every share link across workspaces, filtered and paged server-side. */
export default function AdminDataLinksPage() {
  const { data: session, status } = useSession();
  const role = session?.user?.role ?? null;
  const isAuthed = status === "authenticated";
  const isAdmin = isAuthed && role === "admin";
  const isLocalhost =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  const canUseAdmin = isAdmin || isLocalhost;

  const [q, setQ] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [sortField, setSortField] = useState<SortField>("createdDate");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [total, setTotal] = useState(0);
  const [items, setItems] = useState<LinkRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const totalPages = useMemo(() => Math.max(1, Math.ceil((total || 0) / limit)), [total, limit]);

  useEffect(() => {
    if (!canUseAdmin) return;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const qs = new URLSearchParams();
        qs.set("limit", String(limit));
        qs.set("page", String(page));
        if (q.trim()) qs.set("q", q.trim());
        if (stateFilter) qs.set("state", stateFilter);
        if (kindFilter) qs.set("kind", kindFilter);
        qs.set("sort", sortField);
        qs.set("order", sortOrder);
        const data = await fetchJson<{ links?: unknown; total?: unknown }>(
          `/api/admin/data/links?${qs.toString()}`,
          { method: "GET" },
        );
        setItems(Array.isArray(data.links) ? (data.links as LinkRow[]) : []);
        setTotal(typeof data.total === "number" ? data.total : Number(data.total ?? 0) || 0);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load share links");
        setItems([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    })();
  }, [canUseAdmin, limit, page, q, stateFilter, kindFilter, sortField, sortOrder, reloadKey]);

  if (status === "loading") {
    return <div className="px-6 py-8 text-sm text-[var(--muted)]">Loading…</div>;
  }

  if (!isAuthed && !isLocalhost) {
    return (
      <div className="px-6 py-10">
        <div className="max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Data / Links</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">You must be signed in to view this page.</p>
          <div className="mt-5">
            <Button
              variant="solid"
              className="bg-[var(--primary-bg)] px-5 py-2.5 text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)]"
              onClick={() => void signIn("google", { callbackUrl: "/a/data/links" })}
            >
              Sign in
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!canUseAdmin) {
    return (
      <div className="px-6 py-10">
        <div className="max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Data / Links</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">You don’t have access to this page.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className="mx-auto w-full max-w-6xl px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-[var(--fg)]">Admin / Data / Links</h1>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Every share link, across workspaces. Views and downloads are the link’s own counters, which drift from
              the ShareView records — open a document’s share views for the honest numbers.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="w-[260px] max-w-full"
              placeholder="Search label, audience or slug…"
              value={q}
              onChange={(e) => {
                setPage(1);
                setQ(e.target.value);
              }}
            />
            <Select
              className="w-[190px] max-w-full"
              value={stateFilter}
              onChange={(e) => {
                setPage(1);
                setStateFilter(e.target.value);
              }}
              title="Filter by state"
            >
              <option value="">All states</option>
              <option value="active">Active</option>
              <option value="disabled">Disabled</option>
              <option value="expired">Expired</option>
              <option value="archived">Archived</option>
              <option value="password">Password-protected</option>
            </Select>
            <Select
              className="w-[160px] max-w-full"
              value={kindFilter}
              onChange={(e) => {
                setPage(1);
                setKindFilter(e.target.value);
              }}
              title="Filter by kind"
            >
              <option value="">All links</option>
              <option value="doc">Document links</option>
              <option value="project">Project links</option>
            </Select>
            <Select
              className="w-[200px] max-w-full"
              value={`${sortField}:${sortOrder}`}
              onChange={(e) => {
                const raw = e.target.value || "createdDate:desc";
                const [f, o] = raw.split(":");
                const nextField = (f === "lastViewedAt" || f === "viewCount" ? f : "createdDate") as SortField;
                const nextOrder = (o === "asc" ? "asc" : "desc") as SortOrder;
                setPage(1);
                setSortField(nextField);
                setSortOrder(nextOrder);
              }}
              title="Sort"
            >
              <option value="createdDate:desc">Created (newest)</option>
              <option value="createdDate:asc">Created (oldest)</option>
              <option value="lastViewedAt:desc">Last viewed (newest)</option>
              <option value="viewCount:desc">Views (most)</option>
            </Select>
            <div className="text-xs text-[var(--muted-2)]">
              Page {page} / {totalPages} • {total} total
            </div>
            <Button
              variant="outline"
              className="bg-[var(--panel-2)]"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </Button>
            <Button
              variant="outline"
              className="bg-[var(--panel-2)]"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
            </Button>
            <Button
              variant="outline"
              className="bg-[var(--panel-2)]"
              disabled={loading}
              onClick={() => setReloadKey((v) => v + 1)}
            >
              {loading ? "Loading…" : "Refresh"}
            </Button>
          </div>
        </div>

        {error ? <div className="mt-4 text-sm text-red-700">{error}</div> : null}

        {loading ? (
          <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
            Loading…
          </div>
        ) : (
          <DataTable containerClassName="mt-6 rounded-xl bg-[var(--panel-2)]">
            <thead className="border-b border-[var(--border)] bg-[var(--panel)]">
              <tr className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                <th className="px-4 py-3">Link</th>
                <th className="px-4 py-3">Audience</th>
                <th className="px-4 py-3">Workspace</th>
                <th className="px-4 py-3">Target</th>
                <th className="px-4 py-3">Slug</th>
                <th className="px-4 py-3">State</th>
                <th className="px-4 py-3">Password</th>
                <th className="px-4 py-3">Download</th>
                <th className="px-4 py-3">Expires</th>
                <th className="px-4 py-3">Views</th>
                <th className="px-4 py-3">Downloads</th>
                <th className="px-4 py-3">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {items.map((l) => {
                const path = publicLinkPath(l.kind, l.shareId);
                const target = l.kind === "project" ? l.projectName : l.docTitle;
                return (
                  <tr key={l.id}>
                    <td className="px-4 py-3">
                      {/* Only document links have an admin detail page; a project link has no single
                          document whose viewers could be listed, so its label stays plain text. */}
                      {l.docId ? (
                        <Link
                          href={`/a/shareviews/${encodeURIComponent(l.docId)}`}
                          className="font-semibold text-[var(--fg)] hover:underline"
                          title="View share views for this link’s document"
                        >
                          {l.label ?? "—"}
                        </Link>
                      ) : (
                        <span className="font-semibold text-[var(--fg)]">{l.label ?? "—"}</span>
                      )}
                      {l.isDefault ? <span className="ml-2 text-xs text-[var(--muted-2)]">default</span> : null}
                    </td>
                    <td className="px-4 py-3">{l.audience ?? "—"}</td>
                    <td className="px-4 py-3">
                      {l.workspaceId ? (
                        <Link
                          href={`/a/data/workspaces/${encodeURIComponent(l.workspaceId)}`}
                          className="text-[var(--fg)] hover:underline"
                          title="View this workspace"
                        >
                          {l.workspaceName ?? l.workspaceId}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    {/* Em dash when the document or project row is gone: the link keeps its own
                        analytics, so the row is still worth listing without a name. */}
                    <td className="px-4 py-3">{target ?? "—"}</td>
                    <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">
                      {path ? (
                        <a href={path} className="hover:underline" target="_blank" rel="noreferrer" title="Open the public link">
                          {l.shareId}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[12px] font-semibold ${STATE_CLASS[l.state] ?? STATE_CLASS.active}`}
                      >
                        {linkStateLabel(l.state, { disabledByDocSwitch: l.disabledByDocSwitch })}
                      </span>
                    </td>
                    {/* Whether a password is set, never the password itself or its hash. */}
                    <td className="px-4 py-3">{l.hasPassword ? "Set" : "—"}</td>
                    <td className="px-4 py-3">{l.allowDownload ? "Allowed" : "—"}</td>
                    <td className="px-4 py-3">{fmtDate(l.expiresAt) || "—"}</td>
                    <td className="px-4 py-3" title="The link's own view counter">
                      {Number.isFinite(l.viewCount) ? l.viewCount : "—"}
                    </td>
                    <td className="px-4 py-3" title="The link's own download counter">
                      {Number.isFinite(l.downloadCount) ? l.downloadCount : "—"}
                    </td>
                    <td className="px-4 py-3">{fmtDate(l.createdDate) || "—"}</td>
                  </tr>
                );
              })}
              {items.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-sm text-[var(--muted)]" colSpan={COLUMN_COUNT}>
                    No share links.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </DataTable>
        )}
      </div>
    </div>
  );
}
